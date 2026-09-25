// 研学实操资源编排：事件确定性重放引擎。
//
// 设计要点：
// - 事件流按文件顺序逐条应用（调用方须保证顺序；引擎不做时间排序，以保证“同输入同结果”）。
// - 每条事件的业务效果由守卫判定；被规则拒绝的效果不会生效，但会在 notes 中留下可解释原因。
// - 事件不可原地改写：同 event_id 重复出现时，载荷哈希一致视为重传（忽略），不一致视为异文（暂停其下游）。
// - 全部判断只依赖此前已应用事件，无时钟、无随机数，因此重放结果确定。

import { createHash } from "node:crypto";

export const EVENT_TYPES = [
  "ACTIVITY_DECLARED", // 活动声明：人数、技能前置、耗材批次、安全等级
  "STUDENT_FLAGGED", // 学生风险登记
  "GROUP_CONFIRMED", // 分组确认：确认后才允许预占资源
  "RESOURCE_ALLOCATED", // 预占设备/指导员/场馆时间窗
  "RESOURCE_IN_TRANSIT", // 设备仍在运输（到场前不可用于迁移）
  "SAFETY_OVERRIDE_SIGNED", // 安全教师签署替代方案
  "ACTIVITY_STARTED", // 环节开始：开始后不得被迁移
  "CONSUMABLE_CONSUMED", // 易耗品实际消耗（已开始环节的事实，迁移时不回补）
  "ITINERARY_REVISED", // 行程修订（场馆延误）：只迁移未开始环节
  "WAITLIST_PROMOTED", // 候补转正
  "EVIDENCE_ACCEPTED", // 现场回执 / 学习证据
];

const SAFETY_LEVELS = ["L1", "L2", "L3"];

export function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortValue(value[key])]),
    );
  }
  return value;
}

function payloadHash(payload) {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function eventHash(event) {
  // 业务内容指纹：不含 occurred_at 等元信息；同一逻辑回执的相同重传必须逐业务字段一致。
  return payloadHash({
    event_type: event.event_type,
    aggregate_type: event.aggregate_type,
    aggregate_id: event.aggregate_id,
    payload: event.payload ?? {},
  });
}

// 整条记录指纹：连 event_id、时间、版本、摘要也覆盖，用于检查点检测文件任何改动。
export function recordHash(event) {
  return payloadHash(event);
}

function assertString(record, name) {
  if (typeof record[name] !== "string" || record[name] === "") {
    throw new Error(`事件 ${record.event_id ?? "?"} 缺少字符串字段：${name}`);
  }
}

function keyOf(windowRef) {
  return `${windowRef.venue}|${windowRef.date}|${windowRef.slot}`;
}

function priorityOf(entry) {
  // 可解释的候补公平顺序，越靠前越优先：
  // 1) 安全等级高的小组先补（高风险学生更依赖确定窗口）；
  // 2) 再按原计划开始时间（先被延误者优先）；
  // 3) 再按分组确认时间；
  // 4) 最后按分组编号兜底，保证顺序完全确定。
  return [
    String(SAFETY_LEVELS.length - SAFETY_LEVELS.indexOf(entry.safetyLevel)),
    entry.scheduledStart ?? "",
    entry.groupConfirmedAt ?? "",
    entry.groupId,
  ].join("|");
}

export function createInitialState() {
  return {
    seq: 0,
    eventsSeen: new Map(), // event_id -> { hash, seq }
    poisoned: new Set(), // 异文事件 id：其标记的下游环节暂停
    pausedActivities: new Set(), // 因依赖的回执异文而暂停的活动实例
    activities: new Map(), // activity_id -> 声明
    groups: new Map(), // group_id -> 组状态
    students: new Map(), // student_id -> { riskLevels }
    resources: new Map(), // 资源键 -> 资源台账（设备/指导员/场馆窗口）
    consumables: new Map(), // batch_id -> { total, remaining, lines: 预占行状态机 }
    allocations: [], // 预占记录
    instances: new Map(), // `${group_id}|${activity_id}` -> 环节实例
    waitlists: new Map(), // 资源键 -> [候补条目]
    evidence: new Map(), // evidence_id -> 证据状态
    notes: [], // 可解释的处理记录
    revisionSeq: 0,
  };
}

function note(state, seq, eventId, kind, message) {
  state.notes.push({ seq, event_id: eventId, kind, message });
}

// 只把可序列化的投影内容落进快照。
export function snapshotOf(state) {
  return {
    seq: state.seq,
    revisionSeq: state.revisionSeq,
    eventsSeen: [...state.eventsSeen.entries()].map(([id, v]) => [id, v]),
    poisoned: [...state.poisoned],
    pausedActivities: [...state.pausedActivities],
    activities: [...state.activities.entries()].map(([id, v]) => [id, v]),
    groups: [...state.groups.entries()].map(([id, v]) => [id, v]),
    students: [...state.students.entries()].map(([id, v]) => [id, v]),
    resources: [...state.resources.entries()].map(([id, v]) => [id, v]),
    consumables: [...state.consumables.entries()].map(([id, v]) => [
      id,
      { total: v.total, remaining: v.remaining, lines: v.lines, label: v.label },
    ]),
    allocations: state.allocations,
    instances: [...state.instances.entries()].map(([id, v]) => [id, v]),
    waitlists: [...state.waitlists.entries()].map(([id, v]) => [id, v]),
    evidence: [...state.evidence.entries()].map(([id, v]) => [id, v]),
    notes: state.notes,
  };
}

export function restoreState(snapshot) {
  const state = createInitialState();
  state.seq = snapshot.seq;
  state.revisionSeq = snapshot.revisionSeq;
  state.eventsSeen = new Map(snapshot.eventsSeen);
  state.poisoned = new Set(snapshot.poisoned);
  state.pausedActivities = new Set(snapshot.pausedActivities);
  state.activities = new Map(snapshot.activities);
  state.groups = new Map(snapshot.groups);
  state.students = new Map(snapshot.students);
  state.resources = new Map(snapshot.resources);
  state.consumables = new Map(
    snapshot.consumables.map(([id, v]) => [
      id,
      { batchId: id, total: v.total, remaining: v.remaining, lines: v.lines, label: v.label ?? id },
    ]),
  );
  state.allocations = snapshot.allocations;
  state.instances = new Map(snapshot.instances);
  state.waitlists = new Map(snapshot.waitlists.map(([id, v]) => [id, v]));
  state.evidence = new Map(snapshot.evidence);
  state.notes = snapshot.notes;
  return state;
}

// 应用单条事件。返回 "applied" | "duplicate"（相同重传，已忽略）。
// 异文不抛异常：按领域规则处理为“暂停下游”，保证事件流仍可完整重放。
export function applyEvent(state, rawEvent) {
  for (const name of ["event_id", "event_type", "aggregate_type", "aggregate_id"]) {
    assertString(rawEvent, name);
  }
  if (!EVENT_TYPES.includes(rawEvent.event_type)) {
    throw new Error(`事件 ${rawEvent.event_id} 类型未知：${rawEvent.event_type}`);
  }

  state.seq += 1;
  const seq = state.seq;
  const hash = eventHash(rawEvent);
  const seen = state.eventsSeen.get(rawEvent.event_id);
  if (seen) {
    if (seen.hash !== hash) {
      // 同编号而内容变化：事件本身不入账，并暂停所有声明依赖它的后续环节。
      state.poisoned.add(rawEvent.event_id);
      // 若该编号本身就是已入账回执，其身份已不可信，证据不再有效。
      const contested = state.evidence.get(rawEvent.event_id);
      if (contested) {
        contested.valid = false;
        contested.invalidatedAt = rawEvent.occurred_at ?? null;
      }
      for (const inst of state.instances.values()) {
        if ((inst.evidenceDeps ?? []).includes(rawEvent.event_id)) {
          state.pausedActivities.add(inst.instanceId);
        }
      }
      note(
        state,
        seq,
        rawEvent.event_id,
        "CONFLICTING_RETRANSMISSION",
        `同编号事件内容与首次接收时不一致，未重复入账；依赖它的 ${state.pausedActivities.size} 个环节暂停`,
      );
    }
    return "duplicate";
  }
  state.eventsSeen.set(rawEvent.event_id, { hash, seq });

  const handler = handlers[rawEvent.event_type];
  handler(state, rawEvent, seq);
  return "applied";
}

const handlers = {
  ACTIVITY_DECLARED(state, event, seq) {
    const p = event.payload ?? {};
    const safetyLevel = p.safety_level ?? "L1";
    if (!SAFETY_LEVELS.includes(safetyLevel)) {
      throw new Error(`事件 ${event.event_id} 安全等级非法：${safetyLevel}`);
    }
    const prerequisites = [...(p.skill_prerequisites ?? [])].sort();
    state.activities.set(event.aggregate_id, {
      activityId: event.aggregate_id,
      title: p.title ?? event.aggregate_id,
      declaredSize: p.declared_size ?? 0,
      prerequisites,
      consumableBatches: p.consumable_batches ?? [], // [{ batch_id, qty_per_group }]
      safetyLevel,
      substitutes: p.substitutes ?? [], // 可替代活动 id
      declaredAt: event.occurred_at,
    });
    note(state, seq, event.event_id, "ACTIVITY_DECLARED", `活动声明：${p.title ?? event.aggregate_id}`);
  },

  STUDENT_FLAGGED(state, event) {
    const p = event.payload ?? {};
    const record = state.students.get(event.aggregate_id) ?? { studentId: event.aggregate_id, riskLevels: [] };
    for (const level of p.risk_levels ?? []) {
      if (!record.riskLevels.includes(level)) record.riskLevels.push(level);
    }
    record.riskLevels.sort();
    state.students.set(event.aggregate_id, record);
  },

  GROUP_CONFIRMED(state, event, seq) {
    const p = event.payload ?? {};
    const groupId = event.aggregate_id;
    if (state.groups.has(groupId)) {
      note(state, seq, event.event_id, "IGNORED", `分组 ${groupId} 已确认，重复确认无效`);
      return;
    }
    const members = p.members ?? [];
    const blockedByLevel = {};
    for (const level of SAFETY_LEVELS) blockedByLevel[level] = [];
    for (const member of members) {
      const risks = state.students.get(member.student_id)?.riskLevels ?? [];
      for (const level of risks) blockedByLevel[level].push(member.student_id);
    }
    state.groups.set(groupId, {
      groupId,
      name: p.name ?? groupId,
      confirmedAt: event.occurred_at,
      members,
      blockedByLevel,
      alternatives: [], // [{ student_id, activity_id, signoff_event_id, by }]
      rerouteReasons: [],
      disbanded: false,
    });
    note(state, seq, event.event_id, "GROUP_CONFIRMED", `分组确认：${p.name ?? groupId}（${members.length} 人）`);
  },

  RESOURCE_ALLOCATED(state, event, seq) {
    // payload: { group_id, activity_id, resource: {kind, resource_id, venue,date,slot|batch_id},
    //            capacity?, requires_safety_level? }
    const p = event.payload ?? {};
    const group = state.groups.get(p.group_id);
    if (!group) {
      note(state, seq, event.event_id, "REJECTED", `分组 ${p.group_id} 尚未确认，拒绝预占 ${p.resource?.resource_id}`);
      return;
    }
    if (p.resource.kind === "consumable_batch") {
      reserveConsumable(state, event, p, seq);
      return;
    }
    const activity = state.activities.get(p.activity_id);
    const instance = ensureInstance(state, p.group_id, p.activity_id, event.occurred_at);
    const resource = ensureResource(state, p.resource, activity?.safetyLevel ?? "L1");

    // 安全等级前置：窗口/设备承载等级不得低于活动要求（已签署替代的学生按替代活动计）。
    const requiredLevel = SAFETY_LEVELS.indexOf(activity?.safetyLevel ?? "L1");
    const hostLevel = SAFETY_LEVELS.indexOf(resource.safetyLevel);
    if (hostLevel < requiredLevel) {
      note(
        state,
        seq,
        event.event_id,
        "REJECTED",
        `资源 ${resource.resourceId} 安全等级 ${resource.safetyLevel} 低于活动 ${p.activity_id} 的 ${activity?.safetyLevel} 要求`,
      );
      return;
    }
    if (resource.used >= resource.capacity) {
      const entry = {
        instanceId: instance.instanceId,
        groupId: p.group_id,
        activityId: p.activity_id,
        resourceKind: resource.kind,
        resourceKey: resource.key,
        scheduledStart: instance.scheduledStart,
        groupConfirmedAt: group.confirmedAt,
        safetyLevel: activity?.safetyLevel ?? "L1",
        waitlistedAt: event.occurred_at,
        status: "waiting",
      };
      const queue = state.waitlists.get(resource.key) ?? [];
      queue.push(entry);
      queue.sort((a, b) => (priorityOf(a) < priorityOf(b) ? -1 : 1));
      state.waitlists.set(resource.key, queue);
      note(
        state,
        seq,
        event.event_id,
        "WAITLISTED",
        `${resource.label} 容量已满，小组 ${p.group_id} 进入候补（第 ${queue.length} 位）`,
      );
      return;
    }
    resource.used += 1;
    resource.holders.push(instance.instanceId);
    instance.resources.push(resource.key);
    if (resource.kind === "venue_window") {
      instance.window = { venue: resource.venue, date: resource.date, slot: resource.slot };
    }
    state.allocations.push({
      event_id: event.event_id,
      instanceId: instance.instanceId,
      groupId: p.group_id,
      activityId: p.activity_id,
      resourceKey: resource.key,
      status: "held",
    });
    note(state, seq, event.event_id, "ALLOCATED", `预占 ${resource.label} → ${group.name}/${activity?.title ?? p.activity_id}`);
  },

  RESOURCE_IN_TRANSIT(state, event, seq) {
    // payload: { resource_id, eta }
    const p = event.payload ?? {};
    const key = `device|${p.resource_id}`;
    const device = state.resources.get(key);
    if (device) {
      device.inTransit = true;
      device.eta = p.eta ?? null;
    }
    // 单独的运输标记键：即使设备尚无预占记录，报告中也能体现“仍在运输”。
    state.resources.set(`__transit__${p.resource_id}`, {
      kind: "transit-marker",
      key: `__transit__${p.resource_id}`,
      resourceId: p.resource_id,
      inTransit: true,
      eta: p.eta ?? null,
    });
  },

  SAFETY_OVERRIDE_SIGNED(state, event, seq) {
    // payload: { group_id, student_id, from_activity_id, to_activity_id, reason }
    const p = event.payload ?? {};
    const group = state.groups.get(p.group_id);
    if (!group) {
      note(state, seq, event.event_id, "REJECTED", `分组 ${p.group_id} 未确认，安全教师签署无效`);
      return;
    }
    const from = state.activities.get(p.from_activity_id);
    const to = state.activities.get(p.to_activity_id);
    if (!from || !to) {
      note(state, seq, event.event_id, "REJECTED", "替代方案引用的活动未声明");
      return;
    }
    if (!from.substitutes.includes(p.to_activity_id)) {
      note(state, seq, event.event_id, "REJECTED", `活动 ${from.title} 未将 ${to.title} 列为允许的替代方案`);
      return;
    }
    const student = group.members.find((m) => m.student_id === p.student_id);
    if (!student) {
      note(state, seq, event.event_id, "REJECTED", `学生 ${p.student_id} 不在分组 ${p.group_id}`);
      return;
    }
    if (SAFETY_LEVELS.indexOf(to.safetyLevel) >= SAFETY_LEVELS.indexOf(from.safetyLevel)) {
      note(state, seq, event.event_id, "REJECTED", `替代活动 ${to.title} 安全等级未降低，签署无保护意义`);
      return;
    }
    const prior = group.alternatives.find((a) => a.studentId === p.student_id && a.fromActivityId === p.from_activity_id);
    if (prior) {
      note(state, seq, event.event_id, "IGNORED", `学生 ${p.student_id} 对该活动已有签署替代，重复签署无效`);
      return;
    }
    group.alternatives.push({
      studentId: p.student_id,
      fromActivityId: p.from_activity_id,
      toActivityId: p.to_activity_id,
      reason: p.reason ?? "",
      signoffEventId: event.event_id,
      by: event.payload?.signed_by ?? "安全教师",
    });
    note(
      state,
      seq,
      event.event_id,
      "ALTERNATIVE_SIGNED",
      `安全教师签署：${student.name ?? p.student_id} ${from.title} → ${to.title}（${p.reason ?? ""}）`,
    );
  },

  ACTIVITY_STARTED(state, event, seq) {
    const p = event.payload ?? {};
    const instance = ensureInstance(state, p.group_id, p.activity_id, event.occurred_at);
    if (instance.status === "started" || instance.status === "completed") {
      note(state, seq, event.event_id, "IGNORED", `环节 ${instance.instanceId} 已开始，重复开始事件无效`);
      return;
    }
    const activity = state.activities.get(p.activity_id);
    const group = state.groups.get(p.group_id);

    // 技能前置校验：组内须有持证成员（payload.qualified_members 给出本环节满足前置的学生）。
    const missing = (activity?.prerequisites ?? []).filter((skill) => !(p.qualified_members ?? []).includes(skill));
    if (missing.length > 0) {
      note(state, seq, event.event_id, "REJECTED", `环节 ${instance.instanceId} 缺少技能前置：${missing.join("、")}`);
      return;
    }
    // 高风险学生只允许进入已签署替代的活动。
    // 风险等级约定：学生被标注的风险级别表示“未经签署可参加的最高安全等级”，
    // 活动安全等级高于该标注时必须持有安全教师签署的替代方案。
    const requiredLevelIdx = SAFETY_LEVELS.indexOf(activity?.safetyLevel ?? "L1");
    const unsafed = [];
    for (const member of group.members) {
      const studentRisks = state.students.get(member.student_id)?.riskLevels ?? [];
      const blocked = studentRisks.some((level) => requiredLevelIdx > SAFETY_LEVELS.indexOf(level));
      if (!blocked) continue;
      const signed = group.alternatives.some(
        (a) =>
          a.studentId === member.student_id &&
          (a.fromActivityId === p.activity_id || a.toActivityId === p.activity_id),
      );
      if (!signed) unsafed.push(member.student_id);
    }
    if (unsafed.length > 0) {
      note(
        state,
        seq,
        event.event_id,
        "REJECTED",
        `高风险学生 ${unsafed.join("、")} 缺少安全教师签署的替代方案，环节不得开始`,
      );
      return;
    }
    // 依赖的现场回执若已出现同编号异文，环节暂停，不进入已开始状态。
    instance.evidenceDeps = [...(p.evidence_refs ?? [])];
    const poisonedDeps = instance.evidenceDeps.filter((id) => state.poisoned.has(id));
    if (poisonedDeps.length > 0) {
      state.pausedActivities.add(instance.instanceId);
      note(
        state,
        seq,
        event.event_id,
        "PAUSED",
        `环节 ${instance.instanceId} 依赖的回执 ${poisonedDeps.join("、")} 存在异文，暂停后续环节`,
      );
      return;
    }
    instance.status = "started";
    instance.startedAt = event.occurred_at;
    note(state, seq, event.event_id, "ACTIVITY_STARTED", `环节开始：${group?.name}/${activity?.title}`);
  },

  CONSUMABLE_CONSUMED(state, event, seq) {
    // payload: { group_id, activity_id, batch_id, qty }
    // 实际消耗不新增扣减：按 FIFO 把该环节的预占行由 reserved 结转为 consumed。
    // 已结转数量在迁移时永不回补。
    const p = event.payload ?? {};
    const batch = state.consumables.get(p.batch_id);
    if (!batch) {
      note(state, seq, event.event_id, "REJECTED", `耗材批次 ${p.batch_id} 不存在，消耗事件拒绝入账`);
      return;
    }
    const instance = ensureInstance(state, p.group_id, p.activity_id, event.occurred_at);
    if (instance.status !== "started" && instance.status !== "completed") {
      note(state, seq, event.event_id, "REJECTED", `耗材消耗只能发生在已开始环节：${instance.instanceId}`);
      return;
    }
    const open = batch.lines.filter((l) => l.instanceId === instance.instanceId && l.state === "reserved");
    const openQty = open.reduce((s, l) => s + l.qty, 0);
    if (openQty < p.qty) {
      note(
        state,
        seq,
        event.event_id,
        "REJECTED",
        `耗材 ${p.batch_id} 对 ${instance.instanceId} 可结转预占仅 ${openQty}，不能再消耗 ${p.qty}`,
      );
      return;
    }
    let need = p.qty;
    for (const line of open) {
      if (need <= 0) break;
      const take = Math.min(need, line.qty);
      if (take === line.qty) {
        line.state = "consumed";
        line.consumedEventId = event.event_id;
        line.consumedAt = event.occurred_at;
      } else {
        line.qty -= take;
        batch.lines.push({
          ...line,
          qty: take,
          state: "consumed",
          consumedEventId: event.event_id,
          consumedAt: event.occurred_at,
        });
      }
      need -= take;
    }
    instance.consumptions = instance.consumptions ?? [];
    instance.consumptions.push({ batchId: p.batch_id, qty: p.qty, event_id: event.event_id });
    note(state, seq, event.event_id, "CONSUMED", `实际消耗 ${p.batch_id} × ${p.qty}（${instance.instanceId}，预占结转，不二次扣减）`);
  },

  ITINERARY_REVISED(state, event, seq) {
    // 场馆延误。payload:
    // { venue, reason, closed_until?, moves: [{ group_id, activity_id, from_window, to_window }] }
    const p = event.payload ?? {};
    state.revisionSeq += 1;
    const revisionId = `R${String(state.revisionSeq).padStart(3, "0")}`;
    const moves = p.moves ?? [];

    // 第一轮：校验 + 目标窗口容量试算（不立即生效），冲突者进入按公平顺序排序的候补。
    const planned = [];
    for (const move of moves) {
      const group = state.groups.get(move.group_id);
      const activity = state.activities.get(move.activity_id);
      const instance = state.instances.get(`${move.group_id}|${move.activity_id}`);
      if (!group) {
        note(state, seq, event.event_id, "REJECTED", `迁移失败：分组 ${move.group_id} 不存在`);
        continue;
      }
      if (instance?.status === "started" || instance?.status === "completed") {
        note(
          state,
          seq,
          event.event_id,
          "KEPT",
          `保留已开始环节 ${instance.instanceId}（${activity?.title}）；已消耗试剂不回补，仅迁移后续安排`,
        );
        group.rerouteReasons.push({
          revisionId,
          activityId: move.activity_id,
          reason: `${p.venue} ${p.reason ?? "延误开放"}：环节已开始，保留现场与实际消耗，不迁移本环节，仅顺延后续安排`,
          at: event.occurred_at,
          kept: true,
        });
        continue;
      }
      // status 为 migrated 的环节可被后续场次的再次延误继续迁移；只有“已开始”被锚定。
      if (!activity) {
        note(state, seq, event.event_id, "REJECTED", `迁移失败：活动 ${move.activity_id} 未声明`);
        continue;
      }
      planned.push({ move, group, activity, instance });
    }

    // 同批次迁移在目标窗口上的占位需求，按公平顺序逐个试占；排不进的全部进候补而非取消整组。
    planned
      .map((entry) => ({
        ...entry,
        priority: priorityOf({
          groupId: entry.group.groupId,
          safetyLevel: entry.activity.safetyLevel,
          scheduledStart: entry.move.from_window?.slot ?? entry.instance?.scheduledStart,
          groupConfirmedAt: entry.group.confirmedAt,
        }),
      }))
      .sort((a, b) => (a.priority < b.priority ? -1 : 1))
      .forEach((entry, idx) =>
        migrateOne(state, event, seq, revisionId, entry, idx + 1, planned.length, p),
      );

    note(
      state,
      seq,
      event.event_id,
      "ITINERARY_REVISED",
      `${p.venue} 延误（${p.reason ?? "原因未注明"}）：${moves.length} 个候选迁移，已开始环节保留、消耗不回补`,
    );
  },

  WAITLIST_PROMOTED(state, event, seq) {
    // payload: { resource_key } 或 { instance_id }：显式转正；自动转正在迁移时已即时处理。
    const p = event.payload ?? {};
    let promoted = null;
    if (p.instance_id) {
      for (const [key, queue] of state.waitlists) {
        const idx = queue.findIndex((e) => e.instanceId === p.instance_id && e.status === "waiting");
        if (idx >= 0) {
          promoted = queue.splice(idx, 1)[0];
          if (queue.length === 0) state.waitlists.delete(key);
          break;
        }
      }
    }
    if (!promoted) {
      note(state, seq, event.event_id, "IGNORED", "候补转正事件未找到待补条目");
      return;
    }
    const resource = state.resources.get(promoted.resourceKey);
    if (!resource || resource.used >= resource.capacity) {
      note(state, seq, event.event_id, "REJECTED", `候补条目 ${promoted.instanceId} 转正时容量仍不足`);
      const queue = state.waitlists.get(promoted.resourceKey) ?? [];
      promoted.status = "waiting";
      queue.push(promoted);
      queue.sort((a, b) => (priorityOf(a) < priorityOf(b) ? -1 : 1));
      state.waitlists.set(promoted.resourceKey, queue);
      return;
    }
    resource.used += 1;
    resource.holders.push(promoted.instanceId);
    const inst = state.instances.get(promoted.instanceId);
    if (inst) inst.resources.push(promoted.resourceKey);
    state.allocations.push({
      event_id: event.event_id,
      instanceId: promoted.instanceId,
      groupId: promoted.groupId,
      activityId: promoted.activityId,
      resourceKey: promoted.resourceKey,
      status: "held",
    });
    note(state, seq, event.event_id, "WAITLIST_PROMOTED", `候补转正：${promoted.groupId} → ${promoted.resourceKey}`);
  },

  EVIDENCE_ACCEPTED(state, event, seq) {
    // payload: { group_id, activity_id?, evidence_type, depends_on_event? }
    const p = event.payload ?? {};
    const evidenceId = event.aggregate_id;
    const existing = state.evidence.get(evidenceId);
    if (existing) {
      if (existing.payloadHash === payloadHash(p)) {
        note(
          state,
          seq,
          event.event_id,
          "IGNORED",
          `现场回执 ${evidenceId} 相同重传，不重复入账${existing.valid ? "" : "（该编号已出现异文，仍不恢复）"}`,
        );
        return;
      }
      existing.valid = false;
      existing.invalidatedAt = event.occurred_at ?? null;
      state.poisoned.add(evidenceId);
      for (const inst of state.instances.values()) {
        if ((inst.evidenceDeps ?? []).includes(evidenceId)) state.pausedActivities.add(inst.instanceId);
      }
      note(
        state,
        seq,
        event.event_id,
        "CONFLICTING_RETRANSMISSION",
        `现场回执 ${evidenceId} 同编号内容变化（${existing.evidenceType} → ${p.evidence_type ?? "?"}）：原证据失效，依赖它的 ${state.pausedActivities.size} 个环节暂停`,
      );
      return;
    }
    // 依据已异文上游事件的证据本身不成立。
    if (p.depends_on_event && state.poisoned.has(p.depends_on_event)) {
      note(state, seq, event.event_id, "REJECTED", `证据 ${evidenceId} 依赖的上游回执存在异文，不予采信`);
      return;
    }
    state.evidence.set(evidenceId, {
      evidenceId,
      groupId: p.group_id,
      activityId: p.activity_id ?? null,
      evidenceType: p.evidence_type ?? "unspecified",
      payloadHash: payloadHash(p),
      dependsOnEvent: p.depends_on_event ?? null,
      acceptedAt: event.occurred_at,
      valid: true,
    });
    note(state, seq, event.event_id, "EVIDENCE_ACCEPTED", `学习证据入账：${evidenceId}（${p.evidence_type ?? ""}）`);
  },
};

function migrateOne(state, event, seq, revisionId, entry, rank, total, revisionPayload) {
  const { move, group, activity, instance } = entry;
  const toKey = keyOf(move.to_window);
  const target = ensureResource(
    state,
    {
      kind: "venue_window",
      resource_id: `${move.to_window.venue}:${move.to_window.date}:${move.to_window.slot}`,
      venue: move.to_window.venue,
      date: move.to_window.date,
      slot: move.to_window.slot,
    },
    activity.safetyLevel,
  );

  // 在途设备随迁判断：该环节预占的显微镜若仍在运输，不能作为新窗口可用资源。
  const deviceKeys = (instance?.resources ?? []).filter((k) => k.startsWith("device|"));
  const devicesInTransit = deviceKeys
    .map((k) => state.resources.get(k))
    .filter((r) => r && (r.inTransit || state.resources.get(`__transit__${r.resourceId}`)?.inTransit))
    .map((r) => r.resourceId);

  const reasonParts = [`${revisionPayload.venue} ${revisionPayload.reason ?? "延误开放"}`];
  if (devicesInTransit.length) reasonParts.push(`显微设备在途：${devicesInTransit.join("、")}`);
  if (target.used >= target.capacity) {
    const queueEntry = {
      instanceId: instance?.instanceId ?? `${group.groupId}|${activity.activityId}`,
      groupId: group.groupId,
      activityId: activity.activityId,
      resourceKind: "venue_window",
      resourceKey: toKey,
      scheduledStart: move.from_window?.slot,
      groupConfirmedAt: group.confirmedAt,
      safetyLevel: activity.safetyLevel,
      preferredWindow: move.to_window,
      waitlistedAt: event.occurred_at,
      status: "waiting",
      revisionId,
    };
    const queue = state.waitlists.get(toKey) ?? [];
    queue.push(queueEntry);
    queue.sort((a, b) => (priorityOf(a) < priorityOf(b) ? -1 : 1));
    state.waitlists.set(toKey, queue);
    if (instance) {
      instance.status = "waitlisted";
      instance.revisionId = revisionId;
      // 候补不等于取消：释放已不可用的旧窗口与未消耗预占，整组保留等待公平转正。
      releaseVenueWindow(state, instance);
      releaseReservedConsumables(state, instance.instanceId, seq, event.event_id);
    }
    group.rerouteReasons.push({
      revisionId,
      activityId: activity.activityId,
      reason: `${reasonParts.join("；")}；目标窗口满，按公平顺序候补（第 ${queue.length} 位）`,
      at: event.occurred_at,
    });
    note(
      state,
      seq,
      event.event_id,
      "WAITLISTED",
      `公平顺序 ${rank}/${total}：${group.name} 目标窗口 ${toKey} 已满，整组保留并进候补，不取消分组`,
    );
    return;
  }

  // 释放旧窗口（仅释放尚未开始的环节占用；设备、指导员、耗材预占保留，随组迁移到新窗口）。
  if (instance) {
    releaseVenueWindow(state, instance);
    instance.window = move.to_window;
    instance.status = "migrated";
    instance.revisionId = revisionId;
  } else {
    ensureInstance(state, group.groupId, activity.activityId, event.occurred_at);
    const fresh = state.instances.get(`${group.groupId}|${activity.activityId}`);
    fresh.window = move.to_window;
    fresh.status = "migrated";
    fresh.revisionId = revisionId;
  }
  target.used += 1;
  target.holders.push(instance?.instanceId ?? `${group.groupId}|${activity.activityId}`);
  const inst = state.instances.get(`${group.groupId}|${activity.activityId}`);
  inst.resources.push(toKey);
  state.allocations.push({
    event_id: event.event_id,
    instanceId: inst.instanceId,
    groupId: group.groupId,
    activityId: activity.activityId,
    resourceKey: toKey,
    status: "held",
    revisionId,
  });

  group.rerouteReasons.push({
    revisionId,
    activityId: activity.activityId,
    reason: reasonParts.join("；"),
    fromWindow: move.from_window,
    toWindow: move.to_window,
    at: event.occurred_at,
  });
  note(
    state,
    seq,
    event.event_id,
    "MIGRATED",
    `公平顺序 ${rank}/${total}：${group.name}/${activity.title} ${keyOf(move.from_window)} → ${toKey}`,
  );

  // 迁移腾出容量后，自动按公平顺序提升该资源（旧窗口）的候补队首。
  promoteQueueHead(state, keyOf(move.from_window), seq, event.event_id);
}

function promoteQueueHead(state, resourceKey, seq, causeEventId) {
  const queue = state.waitlists.get(resourceKey);
  const resource = state.resources.get(resourceKey);
  if (!queue || !resource) return;
  while (queue.length > 0 && resource.used < resource.capacity) {
    const head = queue.shift();
    if (head.status !== "waiting") continue;
    resource.used += 1;
    resource.holders.push(head.instanceId);
    head.status = "promoted";
    const inst = state.instances.get(head.instanceId);
    if (inst) {
      inst.resources.push(resourceKey);
      if (head.preferredWindow) inst.window = head.preferredWindow;
      if (inst.status === "waitlisted") inst.status = "migrated";
    }
    const promotedGroup = state.groups.get(head.groupId);
    if (promotedGroup) {
      promotedGroup.rerouteReasons.push({
        revisionId: head.revisionId ?? null,
        activityId: head.activityId,
        reason: `公平顺序候补转正：${resourceKey} 容量释放，队首（${priorityOf(head)}）自动补位，整组未取消`,
        toWindow: head.preferredWindow ?? null,
        promotedBy: causeEventId,
      });
    }
    state.allocations.push({
      event_id: `auto:${causeEventId}:${resourceKey}`,
      instanceId: head.instanceId,
      groupId: head.groupId,
      activityId: head.activityId,
      resourceKey,
      status: "held",
      autoPromoted: true,
    });
    note(
      state,
      seq,
      causeEventId,
      "AUTO_PROMOTED",
      `窗口腾出，候补队首自动转正：${head.groupId}（公平顺序：${priorityOf(head)}）`,
    );
  }
  if (queue.length === 0) state.waitlists.delete(resourceKey);
}

function releaseVenueWindow(state, instance) {
  for (const key of instance.resources) {
    const res = state.resources.get(key);
    if (res?.kind === "venue_window") {
      res.used = Math.max(0, res.used - 1);
      res.holders = res.holders.filter((h) => h !== instance.instanceId);
    }
  }
  instance.resources = instance.resources.filter((key) => state.resources.get(key)?.kind !== "venue_window");
}

function ensureInstance(state, groupId, activityId, at) {
  const key = `${groupId}|${activityId}`;
  let instance = state.instances.get(key);
  if (!instance) {
    instance = {
      instanceId: key,
      groupId,
      activityId,
      status: "planned",
      scheduledStart: at,
      resources: [],
      window: null,
    };
    state.instances.set(key, instance);
  }
  return instance;
}

function ensureResource(state, ref, requiredSafetyLevel) {
  const kind = ref.kind;
  let key;
  let label;
  if (kind === "venue_window") {
    key = keyOf(ref);
    label = `场馆 ${ref.venue} ${ref.date} ${ref.slot}`;
  } else if (kind === "instructor") {
    key = `instructor|${ref.resource_id}`;
    label = `指导员 ${ref.resource_id}`;
  } else {
    key = `${kind}|${ref.resource_id}`;
    label = `${kind === "device" ? "设备" : kind} ${ref.resource_id}`;
  }
  let resource = state.resources.get(key);
  if (!resource) {
    resource = {
      kind,
      key,
      resourceId: ref.resource_id,
      capacity: ref.capacity ?? 1,
      used: 0,
      holders: [],
      safetyLevel: ref.host_safety_level ?? requiredSafetyLevel ?? "L3",
      inTransit: false,
      label,
      venue: ref.venue ?? null,
      date: ref.date ?? null,
      slot: ref.slot ?? null,
    };
    state.resources.set(key, resource);
  }
  return resource;
}

function reserveConsumable(state, event, p, seq) {
  const batchId = p.resource.batch_id ?? p.resource.resource_id;
  const qty = p.resource.qty ?? 1;
  let batch = state.consumables.get(batchId);
  if (!batch) {
    batch = {
      batchId,
      total: p.resource.total ?? qty,
      remaining: p.resource.total ?? qty, // 未预占的可分配余量
      lines: [], // 预占行状态机：reserved -> consumed | released；每行只流转一次
      label: p.resource.label ?? batchId,
    };
    state.consumables.set(batchId, batch);
  }
  if (batch.remaining < qty) {
    note(state, seq, event.event_id, "REJECTED", `耗材批次 ${batchId} 余量 ${batch.remaining} 不足，预占 ${qty} 失败`);
    return;
  }
  batch.remaining -= qty;
  const instance = ensureInstance(state, p.group_id, p.activity_id, event.occurred_at);
  batch.lines.push({
    event_id: event.event_id,
    instanceId: instance.instanceId,
    groupId: p.group_id,
    qty,
    state: "reserved",
  });
  instance.resources.push(`consumable_batch|${batchId}`);
  note(state, seq, event.event_id, "ALLOCATED", `预占耗材 ${batchId} × ${qty}（${instance.instanceId}，余量 ${batch.remaining}）`);
}

// 迁移未开始环节时调用：把该环节仍冻结的耗材预占一次性返还。
// 已结转为 consumed 的行不动；reserved 行只能变 released 一次，杜绝重复返还。
function releaseReservedConsumables(state, instanceId, seq, causeEventId) {
  let releasedTotal = 0;
  for (const batch of state.consumables.values()) {
    for (const line of batch.lines) {
      if (line.instanceId !== instanceId || line.state !== "reserved") continue;
      line.state = "released";
      line.releasedEventId = causeEventId;
      batch.remaining += line.qty;
      releasedTotal += line.qty;
    }
  }
  if (releasedTotal > 0) {
    note(state, seq, causeEventId, "CONSUMABLES_RELEASED", `${instanceId} 尚未开始，冻结预占 ${releasedTotal} 件一次性返还（实际消耗不回补）`);
  }
  return releasedTotal;
}

// 一次重放一段事件流；可从已有 state 继续。
export function replayStream(events, state = createInitialState(), { onApplied = null } = {}) {
  for (const event of events) {
    const result = applyEvent(state, event);
    if (onApplied) onApplied({ event, result, seq: state.seq, state });
  }
  return state;
}

// 事件流指纹：对整条记录的顺序与内容敏感，用作检查点的输入指纹。
export function streamFingerprint(events, upto = events.length) {
  const hash = createHash("sha256");
  for (let i = 0; i < upto; i += 1) hash.update(recordHash(events[i])).update("\n");
  return hash.digest("hex");
}

// 生成对外报告：每个小组的改线原因、资源余量、仍有效的学习证据。
export function buildReport(state, events = null) {
  const inTransitDevices = [...state.resources.values()]
    .filter((r) => r.kind === "transit-marker")
    .map((r) => ({ resource_id: r.resourceId, eta: r.eta, status: "in_transit" }));

  const groupReports = [...state.groups.values()].map((group) => {
    const instances = [...state.instances.values()].filter((i) => i.groupId === group.groupId);
    const signedStudents = group.alternatives.map((a) => {
      const member = group.members.find((m) => m.student_id === a.studentId);
      return {
        student_id: a.studentId,
        student_name: member?.name ?? a.studentId,
        from_activity: state.activities.get(a.fromActivityId)?.title ?? a.fromActivityId,
        to_activity: state.activities.get(a.toActivityId)?.title ?? a.toActivityId,
        reason: a.reason,
        signoff_event: a.signoffEventId,
        signed_by: a.by,
      };
    });
    const validEvidence = [...state.evidence.values()]
      .filter((e) => e.groupId === group.groupId && e.valid)
      .filter((e) => {
        const inst = e.activityId ? state.instances.get(`${group.groupId}|${e.activityId}`) : null;
        return !inst || !state.pausedActivities.has(inst.instanceId);
      })
      .map((e) => ({
        evidence_id: e.evidenceId,
        activity: state.activities.get(e.activityId ?? "")?.title ?? e.activityId,
        type: e.evidenceType,
        accepted_at: e.acceptedAt,
      }));
    return {
      group_id: group.groupId,
      group_name: group.name,
      status: group.disbanded ? "disbanded" : "active",
      members: group.members.length,
      reroute_reasons: group.rerouteReasons.map((r) => ({
        revision: r.revisionId,
        activity: state.activities.get(r.activityId)?.title ?? r.activityId,
        reason: r.reason,
        from: r.fromWindow ? keyOf(r.fromWindow) : null,
        to: r.toWindow ? keyOf(r.toWindow) : null,
      })),
      signed_alternatives: signedStudents,
      segments: instances.map((inst) => ({
        instance_id: inst.instanceId,
        activity: state.activities.get(inst.activityId)?.title ?? inst.activityId,
        status: inst.status,
        window: inst.window ? keyOf(inst.window) : null,
        paused: state.pausedActivities.has(inst.instanceId),
        devices: inst.resources
          .filter((k) => k.startsWith("device|"))
          .map((k) => {
            const r = state.resources.get(k);
            return {
              resource_id: r.resourceId,
              in_transit: Boolean(r.inTransit || state.resources.get(`__transit__${r.resourceId}`)?.inTransit),
            };
          }),
      })),
      valid_learning_evidence: validEvidence,
    };
  });

  const waitlistReport = [...state.waitlists.entries()].flatMap(([resourceKey, queue]) =>
    queue
      .filter((e) => e.status === "waiting")
      .map((e) => ({
        resource: resourceKey,
        group_id: e.groupId,
        activity: state.activities.get(e.activityId)?.title ?? e.activityId,
        priority_key: priorityOf(e),
        revision: e.revisionId ?? null,
      })),
  );

  return {
    generated_by: "study-tour-lab-orchestration replay",
    events_applied: state.eventsSeen.size,
    last_seq: state.seq,
    revisions: state.revisionSeq,
    groups: groupReports,
    resources: {
      venue_windows: [...state.resources.values()]
        .filter((r) => r.kind === "venue_window")
        .map((r) => ({ resource: r.key, capacity: r.capacity, used: r.used, remaining: r.capacity - r.used })),
      devices: [...state.resources.values()]
        .filter((r) => r.kind === "device")
        .map((r) => ({
          resource_id: r.resourceId,
          capacity: r.capacity,
          used: r.used,
          remaining: r.capacity - r.used,
          in_transit: Boolean(r.inTransit || state.resources.get(`__transit__${r.resourceId}`)?.inTransit),
          eta: state.resources.get(`__transit__${r.resourceId}`)?.eta ?? r.eta ?? null,
        })),
      instructors: [...state.resources.values()]
        .filter((r) => r.kind === "instructor")
        .map((r) => ({ resource_id: r.resourceId, capacity: r.capacity, used: r.used, remaining: r.capacity - r.used })),
      consumable_batches: [...state.consumables.values()].map((b) => {
        const qtyBy = (stateName) =>
          b.lines.filter((l) => l.state === stateName).reduce((s, l) => s + l.qty, 0);
        const reservedQty = qtyBy("reserved");
        const consumedQty = qtyBy("consumed");
        const releasedQty = qtyBy("released");
        const balanced = b.total === b.remaining + reservedQty + consumedQty;
        return {
          batch_id: b.batchId,
          label: b.label,
          total: b.total,
          available: b.remaining, // 仍可预占
          reserved: reservedQty, // 冻结中
          consumed: consumedQty, // 实际消耗，不回补
          released: releasedQty, // 迁移时一次性返还的预占（每行仅一次）
          accounting_check: balanced ? "balanced" : "unbalanced",
          lines: b.lines.map((l) => ({
            state: l.state,
            group_id: l.groupId,
            qty: l.qty,
            event_id: l.event_id,
          })),
        };
      }),
      in_transit_markers: inTransitDevices,
    },
    waitlist: waitlistReport,
    paused_dependencies: {
      conflicting_event_ids: [...state.poisoned],
      paused_instances: [...state.pausedActivities],
    },
    decision_log: state.notes,
  };
}
