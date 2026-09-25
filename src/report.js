// 重放结果的只读投影：项目经理视图。
// 输出是纯数据（可 JSON 序列化），CLI 负责渲染文本。所有集合按键排序，保证输出确定性。

import { serializeState } from "./engine.js";

const STATUS_TEXT = {
  scheduled: "已排期",
  waitlisted: "候补中",
  migrated: "已改线",
  started: "进行中",
  completed: "已完成",
  cancelled: "已取消",
  suspended: "已暂停",
};

export function buildReport(state, meta = {}) {
  const groups = [...state.groups.values()].sort((a, b) => (a.group_id < b.group_id ? -1 : 1));

  const groupReports = groups.map((g) => {
    const slots = [...state.slots.values()]
      .filter((s) => s.group_id === g.group_id)
      .sort((a, b) => a.seq - b.seq || (a.slot_id < b.slot_id ? -1 : 1));

    const rerouteReasons = [];
    const slotViews = slots.map((s) => {
      const reasons = [];
      if (s.status === "migrated") reasons.push(`场馆延误改线：${s.old_venue_id}/${s.old_window ?? "?"} → ${s.venue_id}/${s.window ?? "?"}`);
      if (s.status === "waitlisted") {
        const w = s.waitlist.at(-1);
        reasons.push(`候补（公平序 ${w?.fair_rank ?? s.fair_rank ?? 0}）：${w?.because ?? s.reason ?? "场次冲突"}`);
      }
      if (s.status === "suspended") reasons.push(`依赖回执 ${s.suspended_receipt_id} 内容变化，暂停等待处置`);
      if (s.status === "started") reasons.push("环节已开始，延误时保留现场与实际消耗");
      if (s.status === "completed") reasons.push("已完成");
      if (s.reason && s.status === "migrated") reasons.push(`原因码：${s.reason}`);
      if (s.reason?.startsWith("safety_alternative")) reasons.push("安全教师签署的替代实验环节");
      if (reasons.length) rerouteReasons.push({ slot_id: s.slot_id, reasons });
      return {
        slot_id: s.slot_id,
        activity_id: s.activity_id,
        status: s.status,
        status_text: STATUS_TEXT[s.status] ?? s.status,
        venue_id: s.venue_id,
        window: s.window,
        previous: s.old_venue_id ? { venue_id: s.old_venue_id, window: s.old_window } : null,
        fair_rank: s.fair_rank ?? null,
        allocated_resources: [...s.allocated_resources].sort(),
        awaiting_resources: s.candidates.map((c) => c.resource_id),
        consumptions: s.consumptions.map((c) => ({ ...c })),
        reasons,
      };
    });

    const standardStudents = g.members.filter((m) => !m.approved_alternative).map((m) => m.student_id);
    const alternativeStudents = g.members
      .filter((m) => m.approved_alternative)
      .map((m) => ({ student_id: m.student_id, alternative_activity_id: m.approved_alternative,
        safety_teacher: m.approved_by, original_activity_id: m.alternative_of ?? g.original_activity_id }));
    const unsigned = g.pending_alternative.map((p) => ({ student_id: p.student_id, reason: p.reason }));

    const evidence = [...state.evidence.values()]
      .filter((e) => e.group_id === g.group_id)
      .sort((a, b) => (a.evidence_id < b.evidence_id ? -1 : 1))
      .map((e) => ({
        evidence_id: e.evidence_id,
        slot_id: e.slot_id,
        kind: e.kind,
        status: e.status, // valid | revised | suspended
        recorded_at: e.recorded_at,
      }));

    return {
      group_id: g.group_id,
      activity_id: g.activity_id,
      headcount: g.members.length,
      standard_students: standardStudents,
      alternative_students: alternativeStudents,
      unsigned_high_risk: unsigned,
      whole_group_cancelled: false, // 编排规则下恒为 false：只迁学生到替代活动，不取消整组
      slots: slotViews,
      reroute_reasons: rerouteReasons,
      evidence_valid: evidence.filter((e) => e.status === "valid"),
      evidence_revised: evidence.filter((e) => e.status === "revised"),
      evidence_suspended: evidence.filter((e) => e.status === "suspended"),
    };
  });

  const resourceBalances = {
    equipment: [...state.resources.values()]
      .sort((a, b) => (a.resource_id < b.resource_id ? -1 : 1))
      .map((r) => ({
        resource_id: r.resource_id,
        kind: r.kind,
        name: r.name,
        status: r.status, // available | in_transit
        held_by_slot: r.slot_id,
      })),
    consumables: [...state.consumableBatches.values()]
      .sort((a, b) => (a.batch_id < b.batch_id ? -1 : 1))
      .map((b) => ({
        batch_id: b.batch_id,
        name: b.name,
        initial: b.initial,
        consumed: b.initial - b.remaining,
        remaining: b.remaining,
        consumed_by_slot: Object.fromEntries([...b.consumedBySlot.entries()].sort()),
        note: "已开始环节的消耗不随改线返还；每个环节每批次只扣账一次",
      })),
  };

  const waitlist = [...state.slots.values()]
    .flatMap((s) => s.waitlist.map((w) => ({
      slot_id: s.slot_id, group_id: s.group_id, venue_id: w.venue_id, window: w.window,
      fair_rank: w.fair_rank, reason: w.because, at: w.at, promoted: Boolean(w.promoted_at),
      promoted_at: w.promoted_at ?? null, still_waiting: s.status === "waitlisted",
    })))
    .filter((w) => w.still_waiting || w.promoted)
    .sort((a, b) => (a.venue_id < b.venue_id ? -1 : a.venue_id > b.venue_id ? 1
      : a.fair_rank - b.fair_rank || (a.slot_id < b.slot_id ? -1 : 1)));

  const receipts = [...state.receipts.values()]
    .sort((a, b) => (a.receipt_id < b.receipt_id ? -1 : 1))
    .map((r) => ({
      receipt_id: r.receipt_id,
      active_content_hash: r.active_hash,
      version_count: r.versions.size,
      retransmit_count: [...r.versions.values()].reduce((n, v) => n + v.n - 1, 0),
      suspended_slot_ids: [...r.suspended_slot_ids].sort(),
      resolution: r.resolution ?? null,
    }));

  const venues = [...state.venues.values()]
    .sort((a, b) => (a.venue_id < b.venue_id ? -1 : 1))
    .map((v) => ({ venue_id: v.venue_id, status: v.status, opens_at: v.opens_at }));

  return {
    generated_from: "deterministic-event-replay",
    replay: {
      processed_events: meta.processedCount ?? state.processedEventIds.size,
      derived_events: meta.derivedCount ?? null,
      complete: meta.complete ?? true,
      state_hash: meta.stateHash ?? null,
    },
    venues,
    groups: groupReports,
    resource_balances: resourceBalances,
    waitlist,
    receipts,
    state_snapshot: meta.includeSnapshot ? serializeState(state) : undefined,
  };
}

export function renderText(report) {
  const lines = [];
  const p = (s = "") => lines.push(s);
  p("研学多馆延误实验编排 · 重放报告");
  p("=".repeat(56));
  const r = report.replay;
  p(`已处理事件：${r.processed_events}；派生事件：${r.derived_events ?? "-"}；状态指纹：${r.state_hash ?? "-"}；${r.complete ? "流已放完" : "检查点（未放完）"}`);
  p("");

  p("场馆状态：");
  for (const v of report.venues) p(`  - ${v.venue_id}：${v.status === "delayed" ? `延迟开放，预计 ${v.opens_at ?? "时间未定"}` : v.status}`);
  p("");

  for (const g of report.groups) {
    p(`小组 ${g.group_id}（活动 ${g.activity_id}，${g.headcount} 人）`);
    if (g.standard_students.length) p(`  原活动学生：${g.standard_students.join("、")}`);
    for (const a of g.alternative_students) {
      p(`  替代学生：${a.student_id} → ${a.alternative_activity_id}（安全教师 ${a.safety_teacher} 签署，原活动 ${a.original_activity_id}）`);
    }
    for (const u of g.unsigned_high_risk) {
      p(`  待签署：${u.student_id}（${u.reason}）——未签署前原环节不得开始，但整组保留不取消`);
    }
    for (const s of g.slots) {
      p(`  环节 ${s.slot_id} [${s.status_text}] ${s.venue_id ?? "-"}/${s.window ?? "时间未定"}`);
      if (s.awaiting_resources.length) p(`    等待资源：${s.awaiting_resources.join("、")}（运输中，候补到位后自动预占）`);
      if (s.allocated_resources.length) p(`    占用资源：${s.allocated_resources.join("、")}`);
      if (s.consumptions.length) p(`    已消耗耗材：${s.consumptions.map((c) => `${c.batch_id}×${c.quantity}`).join("、")}（不返还）`);
      for (const why of s.reasons) p(`    改线/状态原因：${why}`);
    }
    p("  仍有效学习证据：");
    if (!g.evidence_valid.length && !g.evidence_revised.length && !g.evidence_suspended.length) p("    （暂无）");
    for (const e of g.evidence_valid) p(`    [有效] ${e.evidence_id}（环节 ${e.slot_id}，${e.kind}）`);
    for (const e of g.evidence_revised) p(`    [改线后仍有效] ${e.evidence_id}（环节 ${e.slot_id}，随行程修订保留）`);
    for (const e of g.evidence_suspended) p(`    [暂停核验] ${e.evidence_id}（环节 ${e.slot_id}，依赖回执变更）`);
    p("");
  }

  p("资源余量：");
  for (const b of report.resource_balances.consumables) {
    p(`  耗材 ${b.batch_id}（${b.name}）：初始 ${b.initial} / 已耗 ${b.consumed} / 余量 ${b.remaining}`);
    p(`    扣账明细：${Object.entries(b.consumed_by_slot).map(([sid, q]) => `${sid}=${q}`).join("，") || "无"}`);
  }
  for (const eq of report.resource_balances.equipment) {
    p(`  设备/人力 ${eq.resource_id}（${eq.name}）：${eq.status === "in_transit" ? "运输中" : "在场可用"}${eq.held_by_slot ? `，占用方 ${eq.held_by_slot}` : "，当前空闲"}`);
  }
  p("");

  p("候补队列（公平顺序 = 确认时间 → 环节序号 → 环节编号）：");
  if (!report.waitlist.length) p("  （无）");
  for (const w of report.waitlist) {
    p(`  #${w.fair_rank} 环节 ${w.slot_id} → ${w.venue_id}/${w.window ?? "?"}：${w.reason}${w.promoted ? `（已递进到位${w.promoted_at ? " @ " + w.promoted_at : ""}）` : "（仍在候补）"}`);
  }
  p("");

  p("现场回执：");
  for (const rc of report.receipts) {
    p(`  ${rc.receipt_id}：版本 ${rc.active_content_hash}，重传 ${rc.retransmit_count} 次（未重复入账），${rc.resolution ? `处置=${rc.resolution}` : "处置中"}${rc.suspended_slot_ids.length ? `，暂停环节 ${rc.suspended_slot_ids.join("、")}` : ""}`);
  }
  return lines.join("\n");
}
