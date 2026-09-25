// 研学多馆延误实验编排：事件溯源重放引擎（纯函数、确定性）。
//
// 设计要点：
//  - 输入是不可变事件数组（按现场顺序 offset 递增），输出为投影状态与确定性派生事件；
//  - 活动先声明（人数、技能前置、耗材批次、安全等级），分组确认后才预占设备/指导员/场馆时间窗；
//  - 需要替代方案的学生必须由安全教师签署，签署后改做替代活动，绝不为简化排程取消整组；
//  - 场馆延误时保留已开始环节与实际耗材消耗，只迁移后续安排；冲突场次进入可解释的公平候补；
//  - 易耗品消耗只入账一次（开始即消耗），迁移/释放不返还，重复释放拒绝；
//  - 现场回执按 (receipt_id, content_hash) 幂等：相同重传不重复入账；同编号内容变化则暂停依赖环节；
//  - 学习证据随其来源环节的修订/暂停标记 valid/revised/suspended，不原地删除。

// ---------------------------------------------------------------------------
// 常量与工具
// ---------------------------------------------------------------------------

export const SKILL_LEVELS = ["none", "basic", "intermediate", "advanced"];

const SKILL_RANK = Object.fromEntries(SKILL_LEVELS.map((lv, i) => [lv, i]));

const EQUIPMENT_KINDS = new Set(["equipment", "microscope"]);

export class EngineError extends Error {
  constructor(code, offset, message) {
    super(`[offset=${offset}] ${code}: ${message}`);
    this.code = code;
    this.offset = offset;
  }
}

function now8601(d = new Date()) {
  // 统一 +08:00，报告里不依赖机器本地时区
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().replace("Z", "+08:00");
}

// 键排序的规范化 JSON：内容指纹，跨进程/属性插入顺序稳定
export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

// FNV-1a 32 位：状态/内容指纹，跨进程稳定
export function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function contentHash(payload) {
  return fnv1a(canonical(payload ?? null));
}

export function stateHash(state) {
  return fnv1a(canonical(serializeState(state)));
}

function monotonicStamp(state, baseTime) {
  // 同一物理时刻多个派生事件也有稳定全序：base 时间 + 单调序号（序号随检查点持久化）
  const t = new Date(baseTime).getTime() + state.clock;
  state.clock += 1;
  return now8601(new Date(t));
}

// ---------------------------------------------------------------------------
// 初始状态
// ---------------------------------------------------------------------------

export function initialState() {
  return {
    resources: new Map(), // resource_id -> {resource_id, kind, name, capacity, status, slot_id|null}
    consumableBatches: new Map(), // batch_id -> {batch_id, name, initial, remaining, consumedBySlot:Map}
    activities: new Map(), // activity_id -> 声明
    groups: new Map(), // group_id -> 组与成员
    slots: new Map(), // slot_id -> 环节投影
    venues: new Map(), // venue_id -> {venue_id, status, opens_at}
    receipts: new Map(), // receipt_id -> {versions:Map(hash->{...}), active_hash, suspended_slot_ids}
    evidence: new Map(), // evidence_id -> 证据投影
    seq: 0,
    clock: 0,
    processedEventIds: new Set(),
    eventOrderHash: fnv1a(""),
  };
}

// 可序列化快照（Map -> 有序对象），用于检查点与哈希
export function serializeState(state) {
  const mapOf = (m, fn) => Object.fromEntries([...m.keys()].sort().map((k) => [k, fn(m.get(k))]));
  return {
    resources: mapOf(state.resources, (r) => ({ ...r })),
    consumableBatches: mapOf(state.consumableBatches, (b) => ({
      batch_id: b.batch_id,
      name: b.name,
      initial: b.initial,
      remaining: b.remaining,
      consumedBySlot: Object.fromEntries([...b.consumedBySlot.entries()].sort()),
    })),
    activities: mapOf(state.activities, (a) => ({ ...a })),
    groups: mapOf(state.groups, (g) => ({
      ...g,
      members: g.members.map((m) => ({ ...m })),
    })),
    slots: mapOf(state.slots, (s) => ({
      ...s,
      // 保留 Set 的插入顺序（重放确定），不排序——资源释放顺序依赖它
      allocated_resources: [...s.allocated_resources],
      candidates: s.candidates.map((c) => ({ ...c })),
      waitlist: s.waitlist.map((c) => ({ ...c })),
      reroute_history: (s.reroute_history ?? []).map((h) => ({ ...h })),
    })),
    venues: mapOf(state.venues, (v) => ({ ...v })),
    receipts: mapOf(state.receipts, (r) => ({
      receipt_id: r.receipt_id,
      active_hash: r.active_hash,
      suspended_slot_ids: [...r.suspended_slot_ids].sort(),
      versions: Object.fromEntries([...r.versions.keys()].sort().map((h) => [h, { recordedAt: r.versions.get(h).recordedAt, n: r.versions.get(h).n }])),
    })),
    evidence: mapOf(state.evidence, (e) => ({ ...e })),
    seq: state.seq,
    clock: state.clock,
    processedEventIds: [...state.processedEventIds].sort(),
    eventOrderHash: state.eventOrderHash,
  };
}

function hydrate(raw) {
  const state = initialState();
  for (const [id, r] of Object.entries(raw.resources ?? {})) state.resources.set(id, { ...r });
  for (const [id, b] of Object.entries(raw.consumableBatches ?? {})) {
    state.consumableBatches.set(id, { ...b, consumedBySlot: new Map(Object.entries(b.consumedBySlot ?? {})) });
  }
  for (const [id, a] of Object.entries(raw.activities ?? {})) state.activities.set(id, { ...a });
  for (const [id, g] of Object.entries(raw.groups ?? {})) state.groups.set(id, { ...g, members: (g.members ?? []).map((m) => ({ ...m })) });
  for (const [id, s] of Object.entries(raw.slots ?? {})) {
    state.slots.set(id, {
      ...s,
      allocated_resources: new Set(s.allocated_resources ?? []),
      candidates: (s.candidates ?? []).map((c) => ({ ...c })),
      waitlist: (s.waitlist ?? []).map((c) => ({ ...c })),
    });
  }
  for (const [id, v] of Object.entries(raw.venues ?? {})) state.venues.set(id, { ...v });
  for (const [id, r] of Object.entries(raw.receipts ?? {})) {
    const versions = new Map();
    for (const [h, v] of Object.entries(r.versions ?? {})) versions.set(h, { ...v });
    state.receipts.set(id, {
      receipt_id: id,
      active_hash: r.active_hash ?? null,
      suspended_slot_ids: new Set(r.suspended_slot_ids ?? []),
      versions,
    });
  }
  for (const [id, e] of Object.entries(raw.evidence ?? {})) state.evidence.set(id, { ...e });
  state.seq = raw.seq ?? 0;
  state.clock = raw.clock ?? 0;
  state.processedEventIds = new Set(raw.processedEventIds ?? []);
  state.eventOrderHash = raw.eventOrderHash ?? fnv1a("");
  return state;
}

// ---------------------------------------------------------------------------
// 派生事件
// ---------------------------------------------------------------------------

function derived(state, baseOffset, type, aggregateType, aggregateId, occurredAt, summary, payload = {}) {
  state.seq += 1;
  return {
    event_id: `derived:${type}:${aggregateId}:${String(baseOffset).padStart(4, "0")}:${state.seq}`,
    event_type: type,
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    occurred_at: monotonicStamp(state, occurredAt),
    version: 1,
    summary,
    ...payload,
  };
}

// ---------------------------------------------------------------------------
// 单事件应用
// ---------------------------------------------------------------------------

function applyEvent(state, ev, offset) {
  switch (ev.event_type) {
    case "RESOURCE_REGISTERED":
      return onResourceRegistered(state, ev, offset);
    case "RESOURCE_STATUS_UPDATED":
      return onResourceStatusUpdated(state, ev, offset);
    case "ACTIVITY_DECLARED":
      return onActivityDeclared(state, ev, offset);
    case "GROUP_CONFIRMED":
      return onGroupConfirmed(state, ev, offset);
    case "RESOURCE_ALLOCATED":
    case "RESOURCE_RELEASED":
      return onResourceCommand(state, ev, offset);
    case "ACTIVITY_STARTED":
      return onActivityStarted(state, ev, offset);
    case "ACTIVITY_COMPLETED":
      return onActivityCompleted(state, ev, offset);
    case "VENUE_DELAYED":
      return onVenueDelayed(state, ev, offset);
    case "ITINERARY_REVISED":
      return onItineraryRevised(state, ev, offset);
    case "SLOT_WAITLISTED":
    case "SLOT_SUSPENDED":
      return onSlotMarker(state, ev, offset);
    case "RECEIPT_RECORDED":
      return onReceiptRecorded(state, ev, offset);
    case "RECEIPT_RESOLVED":
      return onReceiptResolved(state, ev, offset);
    case "ALTERNATIVE_APPROVED":
      return onAlternativeApproved(state, ev, offset);
    case "EVIDENCE_ACCEPTED":
      return onEvidenceAccepted(state, ev, offset);
    default:
      throw new EngineError("UNKNOWN_EVENT_TYPE", offset, `未知事件类型 ${ev.event_type}`);
  }
}

function requireFields(ev, offset, fields) {
  for (const f of fields) {
    if (ev[f] === undefined || ev[f] === null) throw new EngineError("MISSING_FIELD", offset, `${ev.event_type} 缺少字段 ${f}`);
  }
}

function onResourceRegistered(state, ev, offset) {
  requireFields(ev, offset, ["resource_id", "kind"]);
  if (state.resources.has(ev.resource_id) || state.consumableBatches.has(ev.resource_id)) {
    throw new EngineError("DUPLICATE_RESOURCE", offset, `资源 ${ev.resource_id} 已登记`);
  }
  if (ev.kind === "consumable") {
    const initial = Number.isFinite(ev.initial_quantity) ? ev.initial_quantity : 0;
    state.consumableBatches.set(ev.resource_id, {
      batch_id: ev.resource_id,
      name: ev.name ?? ev.resource_id,
      initial,
      remaining: initial,
      consumedBySlot: new Map(),
    });
  } else {
    if (!EQUIPMENT_KINDS.has(ev.kind) && ev.kind !== "instructor" && ev.kind !== "venue_window") {
      throw new EngineError("BAD_RESOURCE_KIND", offset, `资源种类 ${ev.kind} 不被识别`);
    }
    state.resources.set(ev.resource_id, {
      resource_id: ev.resource_id,
      kind: ev.kind,
      name: ev.name ?? ev.resource_id,
      venue_id: ev.venue_id ?? null,
      capacity: ev.capacity ?? 1,
      status: ev.status ?? "available", // available | in_transit
      slot_id: null,
    });
  }
  return [];
}

function onResourceStatusUpdated(state, ev, offset) {
  requireFields(ev, offset, ["resource_id", "status"]);
  const res = state.resources.get(ev.resource_id);
  if (!res) throw new EngineError("UNKNOWN_RESOURCE", offset, `资源 ${ev.resource_id} 未登记`);
  const out = [];
  res.status = ev.status; // available | in_transit | unavailable
  if (ev.status === "available") {
    // 运输中设备到场：按公平顺序自动补位给候补环节
    const waiters = fairOrder([...state.slots.values()].filter((s) => s.candidates.some((c) => c.resource_id === ev.resource_id)));
    for (const slot of waiters) promoteWaitlist(state, slot, offset, out, ev.occurred_at);
  } else if (ev.status === "in_transit" && res.slot_id !== null) {
    // 已被占用的设备重新进入运输（如转运下一个馆）：环节退回候补
    const slot = state.slots.get(res.slot_id);
    res.slot_id = null;
    if (slot) {
      slot.allocated_resources.delete(res.resource_id);
      slot.candidates.push({ resource_id: res.resource_id, kind: res.kind, at: ev.occurred_at });
      if (slot.status === "scheduled" || slot.status === "migrated") slot.status = "waitlisted";
      out.push(derived(state, offset, "SLOT_WAITLISTED", "activity_slot", slot.slot_id, ev.occurred_at,
        `设备 ${ev.resource_id} 转运中，环节 ${slot.slot_id} 退回候补`, { reason_code: "EQUIPMENT_IN_TRANSIT" }));
    }
  }
  return out;
}

function onActivityDeclared(state, ev, offset) {
  requireFields(ev, offset, ["activity_id", "declared_headcount", "safety_level"]);
  if (state.activities.has(ev.activity_id)) throw new EngineError("DUPLICATE_ACTIVITY", offset, `活动 ${ev.activity_id} 已声明`);
  if (!Number.isInteger(ev.declared_headcount) || ev.declared_headcount <= 0) {
    throw new EngineError("BAD_HEADCOUNT", offset, "declared_headcount 必须为正整数");
  }
  const skill = ev.skill_prerequisite ?? "none";
  if (!(skill in SKILL_RANK)) throw new EngineError("BAD_SKILL", offset, `未知技能等级 ${skill}`);
  for (const b of ev.consumable_batches ?? []) {
    if (!state.consumableBatches.has(b.batch_id)) throw new EngineError("UNKNOWN_BATCH", offset, `耗材批次 ${b.batch_id} 未登记`);
    if (!Number.isFinite(b.quantity_per_group) || b.quantity_per_group < 0) {
      throw new EngineError("BAD_BATCH_QTY", offset, `批次 ${b.batch_id} 数量非法`);
    }
  }
  state.activities.set(ev.activity_id, {
    activity_id: ev.activity_id,
    name: ev.name ?? ev.activity_id,
    venue_id: ev.venue_id ?? null,
    declared_headcount: ev.declared_headcount,
    skill_prerequisite: skill,
    safety_level: ev.safety_level,
    consumable_batches: (ev.consumable_batches ?? []).map((b) => ({ ...b })),
    required_equipment: [...(ev.required_equipment ?? [])].sort(),
  });
  return [];
}

function memberView(g, studentId) {
  return g.members.find((m) => m.student_id === studentId);
}

function assertWindowFree(state, offset, venueId, window, slotId) {
  for (const s of state.slots.values()) {
    if (s.slot_id === slotId || ["cancelled", "migrated"].includes(s.status)) continue;
    if (s.venue_id === venueId && s.window === window) {
      throw new EngineError("VENUE_WINDOW_CONFLICT", offset,
        `场馆时间窗 ${venueId}/${window ?? "?"} 已被环节 ${s.slot_id} 预占`);
    }
  }
}

function venueOpenAt(state, venueId, window) {
  const v = state.venues.get(venueId);
  if (!v || v.status !== "delayed") return true;
  if (!v.opens_at || !window) return false;
  return new Date(window).getTime() >= new Date(v.opens_at).getTime();
}

function onGroupConfirmed(state, ev, offset) {
  requireFields(ev, offset, ["group_id", "activity_id", "members", "plan"]);
  const out = [];
  if (state.groups.has(ev.group_id)) throw new EngineError("DUPLICATE_GROUP", offset, `小组 ${ev.group_id} 已确认`);
  const activity = state.activities.get(ev.activity_id);
  if (!activity) throw new EngineError("UNKNOWN_ACTIVITY", offset, `活动 ${ev.activity_id} 尚未声明`);
  const members = ev.members.map((m) => ({
    student_id: m.student_id,
    name: m.name ?? m.student_id,
    skill_level: m.skill_level ?? "none",
    risk_level: m.risk_level ?? "standard",
    safety_block: m.safety_block ?? null,
    alternative_of: m.alternative_of ?? null,
  }));
  if (members.length === 0) throw new EngineError("EMPTY_GROUP", offset, "小组至少包含一名学生");
  // 声明人数：以声明容量校验整组规模
  if (members.length > activity.declared_headcount) {
    throw new EngineError("HEADCOUNT_EXCEEDED", offset, `实到 ${members.length} 人，超过声明人数 ${activity.declared_headcount}`);
  }
  for (const m of members) {
    if (!(m.skill_level in SKILL_RANK)) throw new EngineError("BAD_SKILL", offset, `学生 ${m.student_id} 技能等级非法`);
  }
  // 安全门槛：安全等级不足或被安全教师预先标记的学生不得直接参与原活动；
  // 但绝不为简化排程取消整组——这些学生进入 pending_alternative，必须由安全教师签署替代活动。
  const pendingAlternative = [];
  for (const m of members) {
    const blocked = m.safety_block != null
      || SKILL_RANK[m.skill_level] < SKILL_RANK[activity.skill_prerequisite];
    if (blocked) {
      m.pending_alternative = true;
      m.gate_reason = m.safety_block ?? `技能不足（需 ${activity.skill_prerequisite}，实有 ${m.skill_level}）`;
      pendingAlternative.push({ student_id: m.student_id, reason: m.gate_reason });
    }
  }
  // 耗材批次库存校验（声明时即可判定的硬约束）
  for (const b of activity.consumable_batches) {
    const batch = state.consumableBatches.get(b.batch_id);
    if (batch.remaining < b.quantity_per_group) {
      throw new EngineError("INSUFFICIENT_CONSUMABLE", offset,
        `批次 ${b.batch_id} 余量 ${batch.remaining} 不足 ${b.quantity_per_group}`);
    }
  }

  state.groups.set(ev.group_id, {
    group_id: ev.group_id,
    activity_id: ev.activity_id,
    members,
    original_activity_id: ev.activity_id,
    pending_alternative: pendingAlternative,
    confirmed_at: ev.occurred_at,
  });

  // 分组确认后才预占设备、指导员与场馆时间窗
  for (const p of ev.plan ?? []) {
    const slotId = p.slot_id;
    if (state.slots.has(slotId)) throw new EngineError("DUPLICATE_SLOT", offset, `环节 ${slotId} 已存在`);
    const slotVenue = p.venue_id ?? activity.venue_id;
    const slotWindow = p.window ?? null;
    if (slotVenue && slotWindow) assertWindowFree(state, offset, slotVenue, slotWindow, slotId);
    const slot = {
      slot_id: slotId,
      group_id: ev.group_id,
      activity_id: ev.activity_id,
      venue_id: slotVenue,
      window: slotWindow,
      seq: p.seq ?? 0,
      status: "scheduled", // scheduled | waitlisted | migrated | started | completed | cancelled | suspended
      allocated_resources: new Set(),
      candidates: [],
      waitlist: [],
      reroute_history: [],
      consumptions: [],
      reason: null,
      replaced_by: null,
      prior_slot_id: null,
      suspended_receipt_id: null,
      confirmed_event_offset: offset,
    };
    state.slots.set(slotId, slot);
    for (const rid of p.resource_ids ?? []) {
      const res = state.resources.get(rid);
      if (!res) throw new EngineError("UNKNOWN_RESOURCE", offset, `资源 ${rid} 未登记`);
      if (res.slot_id !== null) throw new EngineError("RESOURCE_BUSY", offset, `资源 ${rid} 已被环节 ${res.slot_id} 预占`);
      if (res.status === "in_transit") {
        // 运输中设备：进入公平候补，不硬失败，组不取消
        slot.candidates.push({ resource_id: rid, kind: res.kind, at: ev.occurred_at });
        out.push(derived(state, offset, "SLOT_WAITLISTED", "activity_slot", slotId, ev.occurred_at,
          `设备 ${rid} 仍在运输，环节 ${slotId} 进入候补`,
          { reason_code: "EQUIPMENT_IN_TRANSIT", resource_id: rid, candidates: slot.candidates.map((c) => ({ ...c })) }));
      } else {
        res.slot_id = slotId;
        slot.allocated_resources.add(rid);
        out.push(derived(state, offset, "RESOURCE_ALLOCATED", "resource_unit", rid, ev.occurred_at,
          `资源 ${rid} 预占给环节 ${slotId}`, { slot_id: slotId, group_id: ev.group_id }));
      }
    }
    if (slot.candidates.length > 0) slot.status = "waitlisted";
  }
  return out;
}

function releaseResource(state, resId, slotId, offset, baseTime, out) {
  const res = state.resources.get(resId);
  if (!res) throw new EngineError("UNKNOWN_RESOURCE", offset, `资源 ${resId} 未登记`);
  if (res.slot_id !== slotId) {
    // 已释放/从未占用：拒绝重复释放，防止账本来回腾挪
    throw new EngineError("RELEASE_MISMATCH", offset, `资源 ${resId} 未被环节 ${slotId} 占用（当前 ${res.slot_id}）`);
  }
  res.slot_id = null;
  out.push(derived(state, offset, "RESOURCE_RELEASED", "resource_unit", resId, baseTime,
    `资源 ${resId} 由环节 ${slotId} 释放`, { slot_id: slotId }));
}

function promoteWaitlist(state, slot, offset, out, baseTime) {
  const remaining = [];
  for (const cand of slot.candidates) {
    const res = state.resources.get(cand.resource_id);
    if (res && res.slot_id === null && res.status === "available") {
      res.slot_id = slot.slot_id;
      slot.allocated_resources.add(res.resource_id);
      out.push(derived(state, offset, "RESOURCE_ALLOCATED", "resource_unit", res.resource_id, baseTime,
        `候补到位：资源 ${res.resource_id} 预占给环节 ${slot.slot_id}`, { slot_id: slot.slot_id, from_waitlist: true }));
    } else {
      remaining.push(cand);
    }
  }
  slot.candidates = remaining;
  if (remaining.length === 0 && slot.status === "waitlisted") slot.status = "scheduled";
}

function onResourceCommand(state, ev, offset) {
  requireFields(ev, offset, ["slot_id"]);
  const slot = state.slots.get(ev.slot_id);
  if (!slot) throw new EngineError("UNKNOWN_SLOT", offset, `环节 ${ev.slot_id} 不存在`);
  const out = [];
  if (ev.event_type === "RESOURCE_ALLOCATED") {
    requireFields(ev, offset, ["resource_id"]);
    const res = state.resources.get(ev.resource_id);
    if (!res) throw new EngineError("UNKNOWN_RESOURCE", offset, `资源 ${ev.resource_id} 未登记`);
    if (slot.allocated_resources.has(ev.resource_id)) return []; // 幂等
    if (res.slot_id && res.slot_id !== ev.slot_id) throw new EngineError("RESOURCE_BUSY", offset, `资源 ${ev.resource_id} 已被 ${res.slot_id} 占用`);
    if (res.status === "in_transit") {
      if (!slot.candidates.some((c) => c.resource_id === ev.resource_id)) {
        slot.candidates.push({ resource_id: ev.resource_id, kind: res.kind, at: ev.occurred_at });
      }
      if (slot.status === "scheduled") slot.status = "waitlisted";
      return [];
    }
    res.slot_id = ev.slot_id;
    slot.allocated_resources.add(ev.resource_id);
    promoteWaitlist(state, slot, offset, out, ev.occurred_at);
  } else {
    requireFields(ev, offset, ["resource_id"]);
    releaseResource(state, ev.resource_id, ev.slot_id, offset, ev.occurred_at, out);
  }
  return out;
}

function onActivityStarted(state, ev, offset) {
  requireFields(ev, offset, ["slot_id"]);
  const slot = state.slots.get(ev.slot_id);
  if (!slot) throw new EngineError("UNKNOWN_SLOT", offset, `环节 ${ev.slot_id} 不存在`);
  if (slot.status === "started" || slot.status === "completed") return []; // 幂等重传
  if (slot.status === "cancelled" || slot.status === "suspended") {
    throw new EngineError("SLOT_NOT_STARTABLE", offset, `环节 ${ev.slot_id} 状态为 ${slot.status}，不能开始`);
  }
  if (slot.candidates.length > 0) throw new EngineError("WAITLIST_UNRESOLVED", offset, `环节 ${ev.slot_id} 仍有候补资源未到位`);
  const group = state.groups.get(slot.group_id);
  // 原活动环节必须等高风险学生的替代方案全部签署后才能开始（替代环节自身不受此限）
  if (group && slot.activity_id === group.activity_id && group.pending_alternative.length > 0) {
    throw new EngineError("PENDING_SAFETY_SIGNATURE", offset,
      `小组 ${group.group_id} 尚有 ${group.pending_alternative.length} 名学生等待安全教师签署替代方案：${group.pending_alternative.map((p) => p.student_id).join(",")}`);
  }
  const out = [];
  slot.status = "started";
  slot.started_at = ev.occurred_at;
  // 易耗品在开始时按批次实际消耗，且只消耗一次
  const activity = state.activities.get(slot.activity_id);
  for (const b of activity.consumable_batches) {
    const batch = state.consumableBatches.get(b.batch_id);
    const already = batch.consumedBySlot.get(slot.slot_id) ?? 0;
    if (already > 0) continue; // 重复开始/重传不得重复扣账
    if (batch.remaining < b.quantity_per_group) {
      throw new EngineError("INSUFFICIENT_CONSUMABLE", offset, `批次 ${b.batch_id} 余量不足`);
    }
    batch.remaining -= b.quantity_per_group;
    batch.consumedBySlot.set(slot.slot_id, b.quantity_per_group);
    slot.consumptions.push({ batch_id: b.batch_id, quantity: b.quantity_per_group, at: ev.occurred_at });
  }
  return out;
}

function onActivityCompleted(state, ev, offset) {
  requireFields(ev, offset, ["slot_id"]);
  const slot = state.slots.get(ev.slot_id);
  if (!slot) throw new EngineError("UNKNOWN_SLOT", offset, `环节 ${ev.slot_id} 不存在`);
  if (slot.status === "completed") return [];
  if (slot.status !== "started") throw new EngineError("SLOT_NOT_STARTED", offset, `环节 ${ev.slot_id} 未开始，不能完成`);
  slot.status = "completed";
  slot.completed_at = ev.occurred_at;
  const out = [];
  // 完成后释放可复用设备；已消耗的易耗品不返还
  slot.used_resources = [...slot.allocated_resources];
  for (const rid of [...slot.allocated_resources]) {
    releaseResource(state, rid, slot.slot_id, offset, ev.occurred_at, out);
    slot.allocated_resources.delete(rid);
  }
  return out;
}

function onVenueDelayed(state, ev, offset) {
  requireFields(ev, offset, ["venue_id"]);
  if (!state.venues.has(ev.venue_id)) state.venues.set(ev.venue_id, { venue_id: ev.venue_id, status: "delayed", opens_at: ev.new_opens_at ?? null });
  const v = state.venues.get(ev.venue_id);
  v.status = "delayed";
  if (ev.new_opens_at) v.opens_at = ev.new_opens_at;
  return [];
}

// 公平候补顺序：先到先得（确认时间、环节序号、环节编号全为确定性 tie-break）
function fairOrder(slots) {
  return [...slots].sort((a, b) =>
    a.confirmed_event_offset - b.confirmed_event_offset
    || a.seq - b.seq
    || (a.slot_id < b.slot_id ? -1 : a.slot_id > b.slot_id ? 1 : 0));
}

function conflictKey(venueId, window) {
  return `${venueId}@${window ?? "?"}`;
}

function onItineraryRevised(state, ev, offset) {
  // { revisions: [{slot_id, new_venue_id?, new_window?, keep_resources?[], reason?}], reason }
  requireFields(ev, offset, ["revisions"]);
  if (!Array.isArray(ev.revisions) || ev.revisions.length === 0) {
    throw new EngineError("BAD_REVISION", offset, "revisions 必须为非空数组");
  }
  const out = [];
  const targets = [];

  for (const r of ev.revisions) {
    const slot = state.slots.get(r.slot_id);
    if (!slot) throw new EngineError("UNKNOWN_SLOT", offset, `环节 ${r.slot_id} 不存在`);
    if (slot.status === "started" || slot.status === "completed") {
      // 已开始环节保留：现场进度与实际消耗不回滚，只迁移后续安排
      throw new EngineError("SLOT_IN_PROGRESS", offset, `环节 ${r.slot_id} 已开始/完成，按规则保留不迁移`);
    }
    if (slot.status === "cancelled") throw new EngineError("SLOT_CANCELLED", offset, `环节 ${r.slot_id} 已取消，不能迁移`);
    targets.push({ slot, r });
  }

  // 第一阶段：释放旧占用（已消耗易耗品永不返还）；显式 keep_resources 随组保留
  // targetsSet: 本次修订涉及的环节，其旧窗口都视为"将让出"，不再阻挡后来者
  const targetsSet = new Set(targets.map((t) => t.slot.slot_id));
  const placed = new Map(); // slot_id -> {venue_id, window}，本次已成功改线的最终占位
  const buckets = new Map();
  for (const { slot, r } of targets) {
    const newVenue = r.new_venue_id ?? slot.venue_id;
    const newWindow = r.new_window ?? slot.window;
    const keep = new Set(r.keep_resources ?? []);
    for (const rid of [...slot.allocated_resources]) {
      if (keep.has(rid)) continue;
      releaseResource(state, rid, slot.slot_id, offset, ev.occurred_at, out);
      slot.allocated_resources.delete(rid);
    }
    const key = conflictKey(newVenue, newWindow);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ slot, r, newVenue, newWindow });
  }

  const moveSlot = (slot, venueId, window, fairRank, promoted, out) => {
    slot.reroute_history.push({
      from: { venue_id: slot.venue_id, window: slot.window },
      to: { venue_id: venueId, window },
      reason: slot.reason,
      fair_rank: fairRank,
      promoted_from_waitlist: promoted,
      at: ev.occurred_at,
    });
    slot.old_venue_id = slot.venue_id;
    slot.old_window = slot.window;
    slot.venue_id = venueId;
    slot.window = window;
    slot.status = "migrated";
    slot.fair_rank = fairRank;
    // 改线不抹掉学习证据：已受理证据随环节转为 revised（修订后仍有效）
    for (const e of state.evidence.values()) {
      if (e.slot_id === slot.slot_id && e.status === "valid") e.status = "revised";
    }
    out.push(derived(state, offset, "ITINERARY_REVISED", "activity_slot", slot.slot_id, ev.occurred_at,
      `${promoted ? "候补递进" : "改线"}：环节 ${slot.slot_id} 进入 ${venueId}/${window ?? "?"}（公平序 ${fairRank}）`,
      { old_venue_id: slot.old_venue_id, old_window: slot.old_window, new_venue_id: venueId, new_window: window,
        reason: slot.reason, fair_rank: fairRank, promoted_from_waitlist: promoted }));
  };

  // 第二阶段：同场次按可解释的公平顺序逐组安置；冲突/场馆未开放则带原因候补。
  // 本批迁移环节在其"将让出的旧窗口"不占位；已改放新窗口后立即在新窗口占位，
  // 防止两个组同时落入同一场次；非本批环节的占用始终有效。
  const windowFreeFor = (venueId, window, exceptSlot) => {
    if (!venueOpenAt(state, venueId, window)) {
      return { usable: false, because: `场馆 ${venueId} 延迟至 ${state.venues.get(venueId)?.opens_at ?? "时间未定"}` };
    }
    for (const s of state.slots.values()) {
      if (s.slot_id === exceptSlot || s.status === "cancelled" || s.status === "waitlisted") continue;
      if (s.venue_id !== venueId || s.window !== window) continue;
      if (targetsSet.has(s.slot_id)) {
        const p = placed.get(s.slot_id);
        if (p && p.venue_id === venueId && p.window === window) {
          return { usable: false, because: `场次冲突，同批已安置环节 ${s.slot_id}` };
        }
        continue; // 仍停在将让出的旧窗口，不阻挡同批其他组
      }
      return { usable: false, because: `场次冲突，占位环节 ${s.slot_id}` };
    }
    return { usable: true, because: null };
  };

  // 窗口空出（含本批环节让出旧窗口）时，候补队首按公平序递进，队首不满足不跳号
  const promoteFromQueue = (venueId, window, out) => {
    const queue = fairOrder([...state.slots.values()]
      .filter((s) => s.status === "waitlisted"
        && s.waitlist.some((w) => w.venue_id === venueId && w.window === window && !w.promoted_at)));
    for (const waiter of queue) {
      const check = windowFreeFor(venueId, window, waiter.slot_id);
      if (!check.usable) break;
      const w = waiter.waitlist.filter((x) => x.venue_id === venueId && x.window === window && !x.promoted_at).at(-1);
      w.promoted_at = ev.occurred_at;
      moveSlot(waiter, venueId, window, w.fair_rank, true, out);
      placed.set(waiter.slot_id, { venue_id: venueId, window });
      break; // 每个场馆时间窗容量为 1
    }
  };

  for (const [, bucket] of [...buckets.entries()].sort()) {
    const ordered = fairOrder(bucket.map((x) => x.slot))
      .map((s) => bucket.find((x) => x.slot === s));
    ordered.forEach((x, rank) => { x.fairRank = rank; });

    for (const { slot, r, newVenue, newWindow, fairRank } of ordered) {
      slot.reason = r.reason ?? ev.reason ?? "itinerary_revised";
      const oldVenueId = slot.venue_id;
      const oldWindow = slot.window;
      const check = windowFreeFor(newVenue, newWindow, slot.slot_id);
      if (!check.usable) {
        slot.status = "waitlisted";
        slot.waitlist.push({ venue_id: newVenue, window: newWindow, at: ev.occurred_at,
          because: check.because, fair_rank: fairRank });
        out.push(derived(state, offset, "SLOT_WAITLISTED", "activity_slot", slot.slot_id, ev.occurred_at,
          `环节 ${slot.slot_id} 改线至 ${newVenue}/${newWindow ?? "?"} 候补（公平序 ${fairRank}）：${check.because}`,
          { reason_code: check.because.startsWith("场次") ? "VENUE_WINDOW_CONFLICT" : "VENUE_STILL_CLOSED",
            new_venue_id: newVenue, new_window: newWindow, fair_rank: fairRank }));
        continue;
      }
      moveSlot(slot, newVenue, newWindow, fairRank, false, out);
      placed.set(slot.slot_id, { venue_id: newVenue, window: newWindow });
      // 随组保留的设备继续挂在该环节
      for (const rid of r.keep_resources ?? []) {
        const res = state.resources.get(rid);
        if (res && res.slot_id === slot.slot_id) continue;
        if (res && res.slot_id === null && res.status === "available") {
          res.slot_id = slot.slot_id;
          slot.allocated_resources.add(rid);
          out.push(derived(state, offset, "RESOURCE_ALLOCATED", "resource_unit", rid, ev.occurred_at,
            `改线后资源 ${rid} 继续随环节 ${slot.slot_id}`, { slot_id: slot.slot_id, migrated: true }));
        }
      }
      // 新窗口若此前有空缺（本批更早安置者让出过）先补；再处理本组让出的旧窗口上的候补队首
      promoteFromQueue(newVenue, newWindow, out);
      if (oldVenueId !== newVenue || oldWindow !== newWindow) promoteFromQueue(oldVenueId, oldWindow, out);
    }
  }
  return out;
}

function onSlotMarker(state, ev, offset) {
  // 主要消费历史/外部写入的标记事件；派生标记重放时以幂等方式还原
  requireFields(ev, offset, ["slot_id"]);
  const slot = state.slots.get(ev.slot_id);
  if (!slot) throw new EngineError("UNKNOWN_SLOT", offset, `环节 ${ev.slot_id} 不存在`);
  if (ev.event_type === "SLOT_WAITLISTED") {
    if (slot.status !== "waitlisted") slot.status = "waitlisted";
  } else if (ev.event_type === "SLOT_SUSPENDED") {
    slot.status = "suspended";
    slot.suspended_receipt_id = ev.receipt_id ?? slot.suspended_receipt_id;
  }
  return [];
}

function onReceiptRecorded(state, ev, offset) {
  requireFields(ev, offset, ["receipt_id"]);
  const id = ev.receipt_id;
  const hash = ev.content_hash ?? contentHash(ev.payload);
  if (!state.receipts.has(id)) {
    state.receipts.set(id, { receipt_id: id, versions: new Map(), active_hash: null, suspended_slot_ids: new Set() });
  }
  const r = state.receipts.get(id);
  if (r.versions.has(hash)) {
    // 相同编号 + 相同内容的重传：不重复入账
    const v = r.versions.get(hash);
    v.n += 1;
    return [];
  }
  const out = [];
  const isNewVersion = r.active_hash !== null && r.active_hash !== hash;
  r.versions.set(hash, { hash, recordedAt: ev.occurred_at, n: 1, payload: ev.payload ?? null,
    slot_id: ev.slot_id ?? null, isNewVersion });
  r.active_hash = hash;
  if (isNewVersion) {
    // 同编号而内容变化：暂停依赖它的后续环节（不删除、不改写旧记录）
    const dependents = ev.affected_slot_ids
      ?? [...state.slots.values()].filter((s) => (s.status === "scheduled" || s.status === "waitlisted" || s.status === "migrated")
        && ev.slot_id && (s.slot_id === ev.slot_id)).map((s) => s.slot_id);
    for (const sid of dependents) {
      const slot = state.slots.get(sid);
      if (!slot || ["started", "completed", "cancelled"].includes(slot.status)) continue;
      slot.status = "suspended";
      slot.suspended_receipt_id = id;
      r.suspended_slot_ids.add(sid);
      out.push(derived(state, offset, "SLOT_SUSPENDED", "activity_slot", sid, ev.occurred_at,
        `回执 ${id} 内容发生变化（${hash}），暂停依赖环节 ${sid}`, { receipt_id: id, content_hash: hash }));
      // 暂停的环节释放可复用设备，供其他在场组使用；易耗品不动。记录释放清单以便恢复时取回
      slot.released_on_suspend = [];
      for (const rid of [...slot.allocated_resources]) {
        const res = state.resources.get(rid);
        if (res && res.kind !== "venue_window") {
          releaseResource(state, rid, sid, offset, ev.occurred_at, out);
          slot.allocated_resources.delete(rid);
          slot.released_on_suspend.push(rid);
        }
      }
    }
    // 依赖该回执的学习证据转为 suspended
    for (const e of state.evidence.values()) {
      if (e.receipt_id === id && e.status !== "suspended") {
        e.status = "suspended";
        e.suspended_at = ev.occurred_at;
      }
    }
  }
  return out;
}

function onReceiptResolved(state, ev, offset) {
  requireFields(ev, offset, ["receipt_id", "resolution"]);
  const r = state.receipts.get(ev.receipt_id);
  if (!r) throw new EngineError("UNKNOWN_RECEIPT", offset, `回执 ${ev.receipt_id} 不存在`);
  const out = [];
  r.resolution = ev.resolution; // confirmed_new | voided
  r.resolved_at = ev.occurred_at;
  for (const sid of [...r.suspended_slot_ids]) {
    const slot = state.slots.get(sid);
    if (!slot || slot.status !== "suspended") continue;
    if (ev.resolution === "confirmed_new") {
      slot.status = "scheduled";
      slot.suspended_receipt_id = null;
      r.suspended_slot_ids.delete(sid);
      // 恢复时优先取回暂停期间让出的设备；已被别组占用的重新进入候补
      for (const rid of slot.released_on_suspend ?? []) {
        const res = state.resources.get(rid);
        if (!res) continue;
        if (res.slot_id === null && res.status === "available") {
          res.slot_id = sid;
          slot.allocated_resources.add(rid);
          out.push(derived(state, offset, "RESOURCE_ALLOCATED", "resource_unit", rid, ev.occurred_at,
            `回执新版确认，资源 ${rid} 取回给恢复的环节 ${sid}`, { slot_id: sid, resumed: true }));
        } else if (res.slot_id !== sid) {
          slot.candidates.push({ resource_id: rid, kind: res.kind, at: ev.occurred_at });
          slot.status = "waitlisted";
        }
      }
      slot.released_on_suspend = [];
      out.push(derived(state, offset, "ITINERARY_REVISED", "activity_slot", sid, ev.occurred_at,
        `回执 ${ev.receipt_id} 新版确认，环节 ${sid} 恢复排程`, { resumed: true }));
    }
    // voided：保持暂停，等待人工重排，不自动取消整组
  }
  for (const e of state.evidence.values()) {
    if (e.receipt_id !== ev.receipt_id || e.status !== "suspended") continue;
    if (ev.resolution !== "confirmed_new") continue; // voided：证据保持暂停待核
    // 恢复后证据仍有效；若其环节经历过改线，则回到 revised 而非 valid
    const slot = state.slots.get(e.slot_id);
    e.status = slot && (slot.old_venue_id || (slot.reroute_history ?? []).length > 0) ? "revised" : "valid";
  }
  return out;
}

function onAlternativeApproved(state, ev, offset) {
  requireFields(ev, offset, ["group_id", "student_ids", "alternative_activity_id", "safety_teacher"]);
  const group = state.groups.get(ev.group_id);
  if (!group) throw new EngineError("UNKNOWN_GROUP", offset, `小组 ${ev.group_id} 不存在`);
  const alt = state.activities.get(ev.alternative_activity_id);
  if (!alt) throw new EngineError("UNKNOWN_ACTIVITY", offset, `替代活动 ${ev.alternative_activity_id} 未声明`);
  const out = [];
  for (const sid of ev.student_ids) {
    const m = memberView(group, sid);
    if (!m) throw new EngineError("UNKNOWN_STUDENT", offset, `学生 ${sid} 不在小组 ${ev.group_id}`);
    m.safety_block = null; // 签署后解除门槛阻塞，改做替代活动（不取消整组）
    m.alternative_of = m.alternative_of ?? group.activity_id;
    m.approved_alternative = alt.activity_id;
    m.approved_by = ev.safety_teacher;
    m.approved_at = ev.occurred_at;
    m.pending_alternative = false;
  }
  group.pending_alternative = group.pending_alternative.filter((p) => !ev.student_ids.includes(p.student_id));
  // 为替代活动建立独立环节并预占资源
  if (ev.slot) {
    const p = ev.slot;
    if (state.slots.has(p.slot_id)) throw new EngineError("DUPLICATE_SLOT", offset, `环节 ${p.slot_id} 已存在`);
    const slot = {
      slot_id: p.slot_id, group_id: ev.group_id, activity_id: alt.activity_id,
      venue_id: p.venue_id ?? alt.venue_id, window: p.window ?? null, seq: p.seq ?? 0,
      status: "scheduled", allocated_resources: new Set(), candidates: [], waitlist: [],
      reroute_history: [], consumptions: [], reason: `safety_alternative:signed_by=${ev.safety_teacher}`, replaced_by: null,
      prior_slot_id: p.prior_slot_id ?? null, suspended_receipt_id: null, confirmed_event_offset: offset,
      alternative_student_ids: [...ev.student_ids],
    };
    state.slots.set(slot.slot_id, slot);
    for (const rid of p.resource_ids ?? []) {
      const res = state.resources.get(rid);
      if (!res) throw new EngineError("UNKNOWN_RESOURCE", offset, `资源 ${rid} 未登记`);
      if (res.slot_id !== null) throw new EngineError("RESOURCE_BUSY", offset, `资源 ${rid} 已被 ${res.slot_id} 占用`);
      if (res.status === "in_transit") {
        slot.candidates.push({ resource_id: rid, kind: res.kind, at: ev.occurred_at });
        slot.status = "waitlisted";
        out.push(derived(state, offset, "SLOT_WAITLISTED", "activity_slot", slot.slot_id, ev.occurred_at,
          `替代环节 ${slot.slot_id} 的设备 ${rid} 仍在运输，进入候补`, { reason_code: "EQUIPMENT_IN_TRANSIT" }));
      } else {
        res.slot_id = slot.slot_id;
        slot.allocated_resources.add(rid);
        out.push(derived(state, offset, "RESOURCE_ALLOCATED", "resource_unit", rid, ev.occurred_at,
          `替代环节 ${slot.slot_id} 预占资源 ${rid}`, { slot_id: slot.slot_id, alternative: true }));
      }
    }
  }
  return out;
}

function onEvidenceAccepted(state, ev, offset) {
  requireFields(ev, offset, ["evidence_id", "slot_id", "group_id"]);
  if (state.evidence.has(ev.evidence_id)) return []; // 幂等
  const slot = state.slots.get(ev.slot_id);
  if (!slot) throw new EngineError("UNKNOWN_SLOT", offset, `证据依赖的环节 ${ev.slot_id} 不存在`);
  let status = "valid";
  if (slot.status === "suspended" || slot.suspended_receipt_id) status = "suspended";
  else if (slot.status === "migrated" || slot.status === "waitlisted" || slot.old_venue_id) status = "revised";
  if (ev.receipt_id) {
    const r = state.receipts.get(ev.receipt_id);
    if (r && r.active_hash && [...r.versions.values()].some((v) => v.isNewVersion)) status = "suspended";
  }
  state.evidence.set(ev.evidence_id, {
    evidence_id: ev.evidence_id,
    slot_id: ev.slot_id,
    group_id: ev.group_id,
    student_id: ev.student_id ?? null,
    kind: ev.kind ?? "observation",
    receipt_id: ev.receipt_id ?? null,
    recorded_at: ev.occurred_at,
    status, // valid | revised | suspended
    content_summary: ev.summary ?? "",
  });
  return [];
}

// ---------------------------------------------------------------------------
// 重放
// ---------------------------------------------------------------------------

export function replay(events, options = {}) {
  let state = options.state ?? initialState();
  const derivedEvents = [];
  const allEvents = [];
  const startOffset = options.startOffset ?? 0;

  for (let i = 0; i < events.length; i += 1) {
    const offset = startOffset + i;
    const ev = events[i];
    if (!ev || !ev.event_id) throw new EngineError("BAD_EVENT", offset, "事件缺少 event_id");

    // 断点续跑：已处理事件跳过（调用方负责保证流前缀一致，见 checkpoint.js）
    if (state.processedEventIds.has(ev.event_id) && !ev.event_id.startsWith("derived:")) {
      continue;
    }
    // 引擎自己派生的事件不接受外部重放注入
    if (ev.event_id.startsWith("derived:")) {
      throw new EngineError("DERIVED_EVENT_REPLAY", offset, `派生事件 ${ev.event_id} 只能由引擎生成`);
    }

    const produced = applyEvent(state, ev, offset);
    state.processedEventIds.add(ev.event_id);
    state.eventOrderHash = fnv1a(`${state.eventOrderHash}:${ev.event_id}`);
    allEvents.push(ev);
    for (const d of produced) {
      derivedEvents.push(d);
      allEvents.push(d);
    }
  }

  return {
    state,
    derivedEvents,
    allEvents,
    nextOffset: startOffset + events.length,
    hash: stateHash(state),
  };
}

export { hydrate };
