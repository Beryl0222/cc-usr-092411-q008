import assert from "node:assert/strict";
import test from "node:test";

import {
  applyEvent,
  buildReport,
  createInitialState,
  replayStream,
  stableStringify,
} from "../src/engine.js";
import { buildCheckpoint, verifyAndRestore } from "../src/checkpoint.js";

let seqCounter = 0;
function ev(type, aggregateType, aggregateId, payload = {}, { id = undefined, at = "2026-09-25T09:00:00+08:00", version = 1 } = {}) {
  seqCounter += 1;
  return {
    event_id: id ?? `T${String(seqCounter).padStart(3, "0")}`,
    event_type: type,
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    occurred_at: at,
    version,
    summary: `test ${type}`,
    payload,
  };
}

function declareAndConfirm(state, { groupId = "G1", safety = "L2", members = ["S1"], at = "2026-09-25T08:00:00+08:00", substitutes = [] } = {}) {
  replayStream(
    [
      ev("ACTIVITY_DECLARED", "activity_slot", "ACT", {
        title: "显微实验",
        declared_size: 4,
        skill_prerequisites: ["cert"],
        safety_level: safety,
        substitutes,
      }, { at: "2026-09-25T07:30:00+08:00" }),
      ev(
        "GROUP_CONFIRMED",
        "student_group",
        groupId,
        { name: groupId, members: members.map((student_id) => ({ student_id, name: student_id })) },
        { at },
      ),
    ],
    state,
  );
}

test("分组确认前的资源预占被拒绝，确认后才生效", () => {
  const state = createInitialState();
  replayStream(
    [
      ev("ACTIVITY_DECLARED", "activity_slot", "ACT", { title: "A", safety_level: "L1" }),
      ev("RESOURCE_ALLOCATED", "activity_slot", "ACT", {
        group_id: "G1",
        activity_id: "ACT",
        resource: { kind: "venue_window", resource_id: "V", venue: "馆", date: "d", slot: "s", capacity: 1 },
      }),
    ],
    state,
  );
  assert.equal(state.resources.size, 0, "未确认分组不得产生任何资源台账");
  replayStream(
    [
      ev("GROUP_CONFIRMED", "student_group", "G1", { members: [{ student_id: "S1" }] }),
      ev("RESOURCE_ALLOCATED", "activity_slot", "ACT", {
        group_id: "G1",
        activity_id: "ACT",
        resource: { kind: "venue_window", resource_id: "V2", venue: "馆", date: "d", slot: "s", capacity: 1 },
      }),
    ],
    state,
  );
  assert.equal(state.resources.get("馆|d|s").used, 1);
});

test("高风险学生未经安全教师签署不能开始；签署替代后可以开始", () => {
  const state = createInitialState();
  replayStream(
    [
      ev("ACTIVITY_DECLARED", "activity_slot", "A3", { title: "高等级实验", safety_level: "L3", skill_prerequisites: [], substitutes: ["ALT"] }),
      ev("ACTIVITY_DECLARED", "activity_slot", "ALT", { title: "替代实验", safety_level: "L1", skill_prerequisites: [] }),
      ev("STUDENT_FLAGGED", "student", "S1", { risk_levels: ["L1"] }),
      ev("GROUP_CONFIRMED", "student_group", "G1", { members: [{ student_id: "S1" }] }),
      ev("ACTIVITY_STARTED", "activity_slot", "A3", { group_id: "G1", activity_id: "A3", qualified_members: [] }),
    ],
    state,
  );
  assert.equal(state.instances.get("G1|A3").status, "planned");
  assert.ok(state.notes.some((n) => n.kind === "REJECTED" && n.message.includes("安全教师签署")));

  replayStream(
    [
      ev("SAFETY_OVERRIDE_SIGNED", "student_group", "G1", {
        group_id: "G1",
        student_id: "S1",
        from_activity_id: "A3",
        to_activity_id: "ALT",
        reason: "过敏",
      }),
      ev("ACTIVITY_STARTED", "activity_slot", "A3", { group_id: "G1", activity_id: "A3", qualified_members: [] }),
    ],
    state,
  );
  assert.equal(state.instances.get("G1|A3").status, "started");
});

test("安全教师签署不得指向未声明或安全等级未降低的替代活动", () => {
  const state = createInitialState();
  declareAndConfirm(state, { safety: "L2", substitutes: ["ALT"] });
  replayStream(
    [
      ev("ACTIVITY_DECLARED", "activity_slot", "ALT", { title: "同级", safety_level: "L2" }),
      ev("SAFETY_OVERRIDE_SIGNED", "student_group", "G1", {
        group_id: "G1",
        student_id: "S1",
        from_activity_id: "ACT",
        to_activity_id: "ALT",
      }),
    ],
    state,
  );
  assert.equal(state.groups.get("G1").alternatives.length, 0);
  assert.ok(state.notes.at(-1).message.includes("安全等级未降低"));
});

test("延误时保留已开始环节与实际消耗，只迁移未开始环节", () => {
  const state = createInitialState();
  declareAndConfirm(state, { safety: "L2" });
  replayStream(
    [
      ev("RESOURCE_ALLOCATED", "activity_slot", "ACT", {
        group_id: "G1",
        activity_id: "ACT",
        resource: { kind: "venue_window", resource_id: "V", venue: "A馆", date: "d", slot: "09:00", capacity: 2 },
      }),
      ev("RESOURCE_ALLOCATED", "resource_unit", "B", {
        group_id: "G1",
        activity_id: "ACT",
        resource: { kind: "consumable_batch", batch_id: "B", qty: 5, total: 10 },
      }),
      ev("ACTIVITY_STARTED", "activity_slot", "ACT", { group_id: "G1", activity_id: "ACT", qualified_members: ["cert"] }),
      ev("CONSUMABLE_CONSUMED", "resource_unit", "B", { group_id: "G1", activity_id: "ACT", batch_id: "B", qty: 5 }),
      ev("ITINERARY_REVISED", "activity_slot", "R", {
        venue: "A馆",
        reason: "延误",
        moves: [
          {
            group_id: "G1",
            activity_id: "ACT",
            from_window: { venue: "A馆", date: "d", slot: "09:00" },
            to_window: { venue: "A馆", date: "d", slot: "11:00" },
          },
        ],
      }),
    ],
    state,
  );
  const inst = state.instances.get("G1|ACT");
  assert.equal(inst.status, "started", "已开始环节不得被迁移");
  const batch = state.consumables.get("B");
  assert.equal(batch.lines.filter((l) => l.state === "consumed").reduce((s, l) => s + l.qty, 0), 5);
  assert.equal(batch.remaining, 5, "实际消耗不回补");
  assert.ok(state.notes.some((n) => n.kind === "KEPT"));
});

test("冲突窗口按安全等级→原场次→确认时间→组编号的公平顺序候补，不取消整组", () => {
  const state = createInitialState();
  replayStream(
    [
      ev("ACTIVITY_DECLARED", "activity_slot", "HI", { title: "高", safety_level: "L3", skill_prerequisites: [] }),
      ev("ACTIVITY_DECLARED", "activity_slot", "LO", { title: "低", safety_level: "L2", skill_prerequisites: [] }),
      ev("GROUP_CONFIRMED", "student_group", "GHI", { name: "高风险组", members: [{ student_id: "A" }] }, { at: "2026-09-25T08:10:00+08:00" }),
      ev("GROUP_CONFIRMED", "student_group", "GLO", { name: "低风险组", members: [{ student_id: "B" }] }, { at: "2026-09-25T08:00:00+08:00" }),
      // 第三方 GK 已占住 10:00 唯一窗口，两个延误组公平争抢。
      ev("GROUP_CONFIRMED", "student_group", "GK", { name: "占位组", members: [{ student_id: "C" }] }, { at: "2026-09-25T07:50:00+08:00" }),
      ev("RESOURCE_ALLOCATED", "activity_slot", "OCC", {
        group_id: "GK", activity_id: "HI",
        resource: { kind: "venue_window", resource_id: "W", venue: "馆", date: "d", slot: "10:00", capacity: 1 },
      }),
      ev("ITINERARY_REVISED", "activity_slot", "R", {
        venue: "馆",
        moves: [
          { group_id: "GHI", activity_id: "HI", from_window: { venue: "馆", date: "d", slot: "09:00" }, to_window: { venue: "馆", date: "d", slot: "10:00" } },
          { group_id: "GLO", activity_id: "LO", from_window: { venue: "馆", date: "d", slot: "09:00" }, to_window: { venue: "馆", date: "d", slot: "10:00" } },
        ],
      }),
    ],
    state,
  );
  const queue = state.waitlists.get("馆|d|10:00");
  assert.equal(queue.length, 2);
  assert.deepEqual(queue.map((e) => e.groupId), ["GHI", "GLO"], "L3 组排 L2 组之前，尽管 L2 组确认更早");
  assert.equal(state.groups.get("GLO").disbanded, false);
});

test("候补期间冻结耗材一次性返还；转正重新预占后不发生重复返还", () => {
  const state = createInitialState();
  replayStream(
    [
      ev("ACTIVITY_DECLARED", "activity_slot", "ACT", { title: "实验", safety_level: "L1", skill_prerequisites: [] }),
      ev("GROUP_CONFIRMED", "student_group", "G1", { name: "G1", members: [{ student_id: "S1" }] }, { at: "2026-09-25T08:00:00+08:00" }),
      ev("GROUP_CONFIRMED", "student_group", "G2", { name: "G2", members: [{ student_id: "S2" }] }, { at: "2026-09-25T08:01:00+08:00" }),
      ev("RESOURCE_ALLOCATED", "resource_unit", "B", {
        group_id: "G1", activity_id: "ACT",
        resource: { kind: "consumable_batch", batch_id: "B", qty: 4, total: 4 },
      }),
      // G2 已占住 11:00 唯一窗口。
      ev("RESOURCE_ALLOCATED", "activity_slot", "ACT2", {
        group_id: "G2", activity_id: "ACT",
        resource: { kind: "venue_window", resource_id: "W", venue: "馆", date: "d", slot: "11:00", capacity: 1 },
      }),
      ev("ITINERARY_REVISED", "activity_slot", "R1", {
        venue: "馆",
        moves: [
          { group_id: "G1", activity_id: "ACT", from_window: { venue: "馆", date: "d", slot: "09:00" }, to_window: { venue: "馆", date: "d", slot: "11:00" } },
        ],
      }),
    ],
    state,
  );
  const batch = state.consumables.get("B");
  assert.equal(batch.remaining, 4, "候补（无确定窗口）时冻结预占应一次性返还");
  assert.deepEqual(batch.lines.map((l) => l.state), ["released"]);
  assert.equal(state.instances.get("G1|ACT").status, "waitlisted");

  // G2 迁走，窗口释放，G1 候补队首自动转正，重新预占 4 件。
  applyEvent(state, ev("ITINERARY_REVISED", "activity_slot", "R2", {
    venue: "馆",
    moves: [
      { group_id: "G2", activity_id: "ACT", from_window: { venue: "馆", date: "d", slot: "11:00" }, to_window: { venue: "馆", date: "d", slot: "13:00" } },
    ],
  }));
  assert.equal(batch.remaining, 4, "转正前仍是返还后的余量");
  applyEvent(state, ev("RESOURCE_ALLOCATED", "resource_unit", "B2", {
    group_id: "G1", activity_id: "ACT",
    resource: { kind: "consumable_batch", batch_id: "B", qty: 4 },
  }));
  assert.equal(batch.remaining, 0, "重新预占后余量归零");
  assert.deepEqual(batch.lines.map((l) => l.state), ["released", "reserved"], "旧行保持 released，没有被二次返还");
  const releasedTwice = batch.lines.filter((l) => l.state === "released").length;
  assert.equal(releasedTwice, 1, "同一预占行只允许返还一次");
});

test("相同回执重传不重复入账；同编号异文使证据失效并暂停依赖环节", () => {
  const state = createInitialState();
  declareAndConfirm(state, { safety: "L1" });
  const first = ev("EVIDENCE_ACCEPTED", "learning_evidence", "EV1", {
    group_id: "G1", activity_id: "ACT", evidence_type: "observation_sheet",
  });
  const dup = { ...first, event_id: "DUP", occurred_at: "2026-09-25T09:01:00+08:00" };
  replayStream(
    [
      first,
      dup,
      ev("RESOURCE_ALLOCATED", "activity_slot", "ACT", {
        group_id: "G1", activity_id: "ACT",
        resource: { kind: "venue_window", resource_id: "W", venue: "馆", date: "d", slot: "10:00", capacity: 1 },
      }),
      ev("ACTIVITY_STARTED", "activity_slot", "ACT", {
        group_id: "G1", activity_id: "ACT", qualified_members: ["cert"], evidence_refs: ["EV1"],
      }, { at: "2026-09-25T10:05:00+08:00" }),
    ],
    state,
  );
  assert.equal(state.evidence.size, 1);
  assert.equal(state.evidence.get("EV1").valid, true);
  assert.equal(state.instances.get("G1|ACT").status, "started");

  // 同编号异文（业务 payload 不同）。
  applyEvent(state, ev("EVIDENCE_ACCEPTED", "learning_evidence", "EV1", {
    group_id: "G1", activity_id: "ACT", evidence_type: "digital_image",
  }, { id: "CONFLICT", at: "2026-09-25T10:30:00+08:00", version: 2 }));
  assert.equal(state.evidence.get("EV1").valid, false);
  assert.ok(state.pausedActivities.has("G1|ACT"));
  const report = buildReport(state);
  const g1 = report.groups.find((g) => g.group_id === "G1");
  assert.equal(g1.valid_learning_evidence.length, 0, "失效证据不再出现在仍有效证据中");

  // 再以原内容重传也不恢复。
  applyEvent(state, { ...first, event_id: "DUP2", occurred_at: "2026-09-25T10:35:00+08:00" });
  assert.equal(state.evidence.get("EV1").valid, false);
});

test("同 event_id 不同载荷的重传被标记为异文且不入账", () => {
  const state = createInitialState();
  const a = ev("STUDENT_FLAGGED", "student", "S9", { risk_levels: ["L1"] }, { id: "SAME-ID" });
  const b = ev("STUDENT_FLAGGED", "student", "S9", { risk_levels: ["L3"] }, { id: "SAME-ID" });
  applyEvent(state, a);
  applyEvent(state, b);
  assert.deepEqual(state.students.get("S9").riskLevels, ["L1"], "异文不得改写既有状态");
  assert.ok(state.poisoned.has("SAME-ID"));
});

test("易耗品消耗不得超过预占，且只能发生在已开始环节", () => {
  const state = createInitialState();
  declareAndConfirm(state, { safety: "L1" });
  replayStream(
    [
      ev("RESOURCE_ALLOCATED", "resource_unit", "B", {
        group_id: "G1", activity_id: "ACT",
        resource: { kind: "consumable_batch", batch_id: "B", qty: 3, total: 10 },
      }),
      ev("CONSUMABLE_CONSUMED", "resource_unit", "B", { group_id: "G1", activity_id: "ACT", batch_id: "B", qty: 3 }),
    ],
    state,
  );
  assert.equal(state.consumables.get("B").lines.filter((l) => l.state === "consumed").length, 0, "未开始不得消耗");
  replayStream(
    [ev("ACTIVITY_STARTED", "activity_slot", "ACT", { group_id: "G1", activity_id: "ACT", qualified_members: ["cert"] })],
    state,
  );
  applyEvent(state, ev("CONSUMABLE_CONSUMED", "resource_unit", "B", { group_id: "G1", activity_id: "ACT", batch_id: "B", qty: 4 }));
  assert.equal(state.consumables.get("B").lines.filter((l) => l.state === "consumed").length, 0, "超预占消耗被拒绝");
  applyEvent(state, ev("CONSUMABLE_CONSUMED", "resource_unit", "B", { group_id: "G1", activity_id: "ACT", batch_id: "B", qty: 2 }));
  applyEvent(state, ev("CONSUMABLE_CONSUMED", "resource_unit", "B", { group_id: "G1", activity_id: "ACT", batch_id: "B", qty: 1 }));
  const consumed = state.consumables.get("B").lines.filter((l) => l.state === "consumed").reduce((s, l) => s + l.qty, 0);
  assert.equal(consumed, 3, "结转总量不得超过预占 3");
  applyEvent(state, ev("CONSUMABLE_CONSUMED", "resource_unit", "B", { group_id: "G1", activity_id: "ACT", batch_id: "B", qty: 1 }));
  assert.equal(
    state.consumables.get("B").lines.filter((l) => l.state === "consumed").reduce((s, l) => s + l.qty, 0),
    3,
    "预占全部结转后再消耗必须被拒绝",
  );
});

test("检查点保存与恢复后继续重放得到完全相同的终态报告", () => {
  const events = [
    ev("ACTIVITY_DECLARED", "activity_slot", "ACT", { title: "A", safety_level: "L1", skill_prerequisites: [] }),
    ev("GROUP_CONFIRMED", "student_group", "G1", { members: [{ student_id: "S1" }] }),
    ev("RESOURCE_ALLOCATED", "activity_slot", "ACT", {
      group_id: "G1", activity_id: "ACT",
      resource: { kind: "venue_window", resource_id: "W", venue: "馆", date: "d", slot: "09:00", capacity: 1 },
    }),
    ev("ITINERARY_REVISED", "activity_slot", "R", {
      venue: "馆",
      moves: [
        { group_id: "G1", activity_id: "ACT", from_window: { venue: "馆", date: "d", slot: "09:00" }, to_window: { venue: "馆", date: "d", slot: "10:00" } },
      ],
    }),
  ];
  const full = replayStream(events.map((x) => x), createInitialState());
  const fullReport = stableStringify(buildReport(full));

  const partial = replayStream(events.slice(0, 2), createInitialState());
  const checkpoint = buildCheckpoint(partial, events);
  const restored = verifyAndRestore(checkpoint, events);
  replayStream(events.slice(2), restored);
  assert.equal(stableStringify(buildReport(restored)), fullReport);
});

test("事件流任何字段被改动后，检查点拒绝续跑", () => {
  const events = [
    ev("GROUP_CONFIRMED", "student_group", "G1", { members: [] }, { id: "E1" }),
    ev("GROUP_CONFIRMED", "student_group", "G2", { members: [] }, { id: "E2" }),
  ];
  const partial = replayStream(events.slice(0, 1), createInitialState());
  const checkpoint = buildCheckpoint(partial, events);
  const tampered = events.map((e) => (e.event_id === "E2" ? { ...e, summary: "被改写" } : e));
  assert.throws(() => verifyAndRestore(checkpoint, tampered), /指纹/);
});

test("设备在运输状态在报告中可见并随改线原因输出", () => {
  const state = createInitialState();
  declareAndConfirm(state, { safety: "L1" });
  replayStream(
    [
      ev("RESOURCE_ALLOCATED", "resource_unit", "MIC-9", {
        group_id: "G1", activity_id: "ACT",
        resource: { kind: "device", resource_id: "MIC-9", capacity: 1 },
      }),
      ev("RESOURCE_IN_TRANSIT", "resource_unit", "MIC-9", { resource_id: "MIC-9", eta: "2026-09-25T11:30:00+08:00" }),
      ev("ITINERARY_REVISED", "activity_slot", "R", {
        venue: "A馆",
        reason: "延误",
        moves: [
          { group_id: "G1", activity_id: "ACT", from_window: { venue: "A馆", date: "d", slot: "09:00" }, to_window: { venue: "B馆", date: "d", slot: "11:00" } },
        ],
      }),
    ],
    state,
  );
  const report = buildReport(state);
  assert.ok(report.groups[0].reroute_reasons[0].reason.includes("显微设备在途：MIC-9"));
  assert.ok(report.resources.devices.find((d) => d.resource_id === "MIC-9").in_transit);
});
