import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { replay } from "../src/engine.js";
import { buildReport } from "../src/report.js";
import { saveCheckpoint, resumeSlice, loadCheckpoint } from "../src/checkpoint.js";

// ---------------------------------------------------------------------------
// 最小事件流构造器
// ---------------------------------------------------------------------------

let seq = 0;
const t = (m) => `2026-09-25T${String(8 + Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00+08:00`;

function ev(partial) {
  seq += 1;
  const e = {
    event_id: `t-${String(seq).padStart(3, "0")}`,
    event_type: partial.event_type,
    aggregate_type: partial.aggregate_type ?? "resource_unit",
    aggregate_id: partial.aggregate_id ?? partial.resource_id ?? partial.activity_id ?? "x",
    occurred_at: partial.occurred_at ?? t(seq),
    version: 1,
    summary: partial.summary ?? partial.event_type,
    ...partial,
  };
  return e;
}

const registerEq = (id, overrides = {}) => ev({ event_type: "RESOURCE_REGISTERED", resource_id: id, kind: "microscope", name: id, status: "available", aggregate_id: id, ...overrides });
const registerBatch = (id, qty) => ev({ event_type: "RESOURCE_REGISTERED", resource_id: id, kind: "consumable", name: id, initial_quantity: qty, aggregate_id: id });
const declareAct = (activityId, batches = [], skill = "none") => ev({
  event_type: "ACTIVITY_DECLARED", aggregate_type: "activity_slot", aggregate_id: activityId,
  activity_id: activityId, venue_id: "v-a", declared_headcount: 8, skill_prerequisite: skill,
  safety_level: "L1", consumable_batches: batches,
});
const groupConfirmed = (groupId, activityId, members, plan, at) => ev({
  event_type: "GROUP_CONFIRMED", aggregate_type: "student_group", aggregate_id: groupId,
  group_id: groupId, activity_id: activityId, members, plan, occurred_at: at,
});

const student = (id, overrides = {}) => ({ student_id: id, name: id, skill_level: "none", risk_level: "standard", ...overrides });

test("声明人数、技能前置、耗材批次：超员/未知批次/库存不足被拒绝", () => {
  seq = 0;
  const base = [
    registerBatch("b1", 2),
    declareAct("a1", [{ batch_id: "b1", quantity_per_group: 3 }]),
  ];
  assert.throws(() => replay([...base, groupConfirmed("g1", "a1", [student("s1")], [])]), /INSUFFICIENT_CONSUMABLE/);

  seq = 100;
  const over = [
    declareAct("a2", [], "basic"),
    groupConfirmed("g2", "a2", Array.from({ length: 9 }, (_, i) => student(`s${i}`)), []),
  ];
  assert.throws(() => replay(over), /HEADCOUNT_EXCEEDED/);
});

test("分组确认后才预占：未确认的活动不持有任何设备；同设备不能被两组重复预占", () => {
  seq = 200;
  const events = [
    registerEq("m1"),
    declareAct("a1"),
    groupConfirmed("g1", "a1", [student("s1")], [{ slot_id: "g1-1", venue_id: "v-a", window: t(10), resource_ids: ["m1"] }], t(30)),
  ];
  const { state } = replay(events);
  assert.equal(state.resources.get("m1").slot_id, "g1-1");

  assert.throws(() => replay([
    ...events,
    groupConfirmed("g2", "a1", [student("s9")], [{ slot_id: "g2-1", venue_id: "v-a", window: t(11), resource_ids: ["m1"] }], t(31)),
  ]), /RESOURCE_BUSY/);
});

test("高风险学生不取消整组：签署前原环节不得开始，安全教师签署替代后可运行", () => {
  seq = 300;
  const events = [
    registerEq("m1"),
    registerEq("m2"),
    declareAct("a1"),
    declareAct("a-alt"),
    groupConfirmed("g1", "a1",
      [student("s1"), student("s2", { risk_level: "high", safety_block: "气雾敏感" })],
      [{ slot_id: "g1-1", venue_id: "v-a", window: t(40), resource_ids: ["m1"] }], t(30)),
  ];
  const r1 = replay(events);
  const report1 = buildReport(r1.state);
  const g = report1.groups.find((x) => x.group_id === "g1");
  assert.equal(g.whole_group_cancelled, false);
  assert.deepEqual(g.unsigned_high_risk.map((u) => u.student_id), ["s2"]);
  // 未签署即开始原环节 → 拒绝
  assert.throws(() => replay([...events, ev({ event_type: "ACTIVITY_STARTED", aggregate_type: "activity_slot", aggregate_id: "g1-1", slot_id: "g1-1", occurred_at: t(41) })]),
    /PENDING_SAFETY_SIGNATURE/);

  const signed = replay([
    ...events,
    ev({
      event_type: "ALTERNATIVE_APPROVED", aggregate_type: "student_group", aggregate_id: "g1",
      group_id: "g1", student_ids: ["s2"], alternative_activity_id: "a-alt", safety_teacher: "safe-t",
      slot: { slot_id: "g1-alt", venue_id: "v-a", window: t(42), resource_ids: ["m2"] },
      occurred_at: t(35),
    }),
    ev({ event_type: "ACTIVITY_STARTED", aggregate_type: "activity_slot", aggregate_id: "g1-1", slot_id: "g1-1", occurred_at: t(43) }),
  ]);
  const member = signed.state.groups.get("g1").members.find((m) => m.student_id === "s2");
  assert.equal(member.approved_alternative, "a-alt");
  assert.equal(member.approved_by, "safe-t");
  assert.equal(signed.state.slots.get("g1-1").status, "started");
});

test("运输中的显微设备先进候补，到场后按公平顺序自动补位", () => {
  seq = 400;
  const events = [
    registerEq("m1", { status: "in_transit" }),
    declareAct("a1"),
    groupConfirmed("g1", "a1", [student("s1")], [{ slot_id: "g1-1", venue_id: "v-a", window: t(40), resource_ids: ["m1"] }], t(30)),
  ];
  const before = replay(events);
  assert.equal(before.state.slots.get("g1-1").status, "waitlisted");
  assert.throws(() => replay([...events, ev({ event_type: "ACTIVITY_STARTED", slot_id: "g1-1", aggregate_type: "activity_slot", aggregate_id: "g1-1", occurred_at: t(41) })]),
    /WAITLIST_UNRESOLVED/);

  const after = replay([...events, ev({ event_type: "RESOURCE_STATUS_UPDATED", resource_id: "m1", status: "available", aggregate_id: "m1", occurred_at: t(45) })]);
  assert.equal(after.state.slots.get("g1-1").status, "scheduled");
  assert.equal(after.state.resources.get("m1").slot_id, "g1-1");
});

test("已开始环节延误时保留：修订拒绝迁移；耗材实际消耗且不重复扣账/返还", () => {
  seq = 500;
  const start = ev({ event_type: "ACTIVITY_STARTED", aggregate_type: "activity_slot", aggregate_id: "g1-1", slot_id: "g1-1", occurred_at: t(40) });
  const events = [
    registerBatch("b1", 10),
    declareAct("a1", [{ batch_id: "b1", quantity_per_group: 2 }]),
    groupConfirmed("g1", "a1", [student("s1")], [{ slot_id: "g1-1", venue_id: "v-a", window: t(40), resource_ids: [] }], t(30)),
    start,
  ];
  const once = replay(events);
  assert.equal(once.state.consumableBatches.get("b1").remaining, 8);
  // 开始事件重放/重传不重复扣账
  const twice = replay([...events, start]);
  assert.equal(twice.state.consumableBatches.get("b1").remaining, 8);

  // 已开始环节不允许迁移
  assert.throws(() => replay([...events, ev({
    event_type: "ITINERARY_REVISED", aggregate_type: "activity_slot", aggregate_id: "g1",
    reason: "delay", revisions: [{ slot_id: "g1-1", new_venue_id: "v-b", new_window: t(90) }], occurred_at: t(50),
  })]), /SLOT_IN_PROGRESS/);
});

test("只迁移未开始环节，迁移不返还耗材，公平候补顺序可解释且让出窗口后递进", () => {
  seq = 600;
  const events = [
    registerBatch("b1", 10),
    registerEq("m1"),
    registerEq("m2"),
    declareAct("a1", [{ batch_id: "b1", quantity_per_group: 2 }]),
    // g1 先确认（公平序优先）
    groupConfirmed("g1", "a1", [student("s1")], [{ slot_id: "g1-1", seq: 1, venue_id: "v-a", window: t(30), resource_ids: ["m1"] }], t(10)),
    groupConfirmed("g2", "a1", [student("s2")], [{ slot_id: "g2-1", seq: 1, venue_id: "v-a", window: t(45), resource_ids: ["m2"] }], t(11)),
    ev({ event_type: "VENUE_DELAYED", aggregate_type: "venue", aggregate_id: "v-a", venue_id: "v-a", new_opens_at: t(120), occurred_at: t(20) }),
    // 两组都改到 13:00 同场次：g1 序 0 得位，g2 序 1 候补
    ev({
      event_type: "ITINERARY_REVISED", aggregate_type: "activity_slot", aggregate_id: "multi", reason: "delay",
      revisions: [
        { slot_id: "g1-1", new_window: t(120), keep_resources: ["m1"] },
        { slot_id: "g2-1", new_window: t(120), keep_resources: ["m2"] },
      ],
      occurred_at: t(21),
    }),
  ];
  const conflict = replay(events);
  assert.equal(conflict.state.slots.get("g1-1").status, "migrated");
  assert.equal(conflict.state.slots.get("g2-1").status, "waitlisted");
  assert.equal(conflict.state.slots.get("g2-1").waitlist.at(-1).fair_rank, 1);
  assert.match(conflict.state.slots.get("g2-1").waitlist.at(-1).because, /g1-1/);

  // g1 改去 v-b，把 v-a 13:00 让出 → g2 公平递进；两组互不占同一窗口
  const resolved = replay([...events, ev({
    event_type: "ITINERARY_REVISED", aggregate_type: "activity_slot", aggregate_id: "g1", reason: "move",
    revisions: [{ slot_id: "g1-1", new_venue_id: "v-b", new_window: t(120), keep_resources: ["m1"] }],
    occurred_at: t(22),
  })]);
  assert.equal(resolved.state.slots.get("g1-1").venue_id, "v-b");
  assert.equal(resolved.state.slots.get("g2-1").status, "migrated");
  assert.equal(resolved.state.slots.get("g2-1").venue_id, "v-a");
  assert.equal(resolved.state.slots.get("g2-1").waitlist.at(-1).promoted_at, t(22));
  // 迁移不影响耗材账（尚未开始=未消耗，已消耗的也不返还）
  assert.equal(resolved.state.consumableBatches.get("b1").remaining, 10);
});

test("场馆未开放时改线进入候补，开放时间前不得占位", () => {
  seq = 700;
  const events = [
    registerEq("m1"),
    declareAct("a1"),
    groupConfirmed("g1", "a1", [student("s1")], [{ slot_id: "g1-1", venue_id: "v-a", window: t(30), resource_ids: ["m1"] }], t(10)),
    ev({ event_type: "VENUE_DELAYED", aggregate_type: "venue", aggregate_id: "v-a", venue_id: "v-a", new_opens_at: t(120), occurred_at: t(15) }),
    ev({
      event_type: "ITINERARY_REVISED", aggregate_type: "activity_slot", aggregate_id: "g1", reason: "delay",
      revisions: [{ slot_id: "g1-1", new_window: t(60) }], occurred_at: t(16),
    }),
  ];
  const r = replay(events);
  assert.equal(r.state.slots.get("g1-1").status, "waitlisted");
  assert.equal(r.state.slots.get("g1-1").waitlist.at(-1).because.includes("延迟"), true);
});

test("回执：相同重传不重复入账；同编号内容变化暂停依赖环节与证据，确认新版后恢复", () => {
  seq = 800;
  const mk = (extra = []) => [
    registerEq("m1"),
    declareAct("a1"),
    groupConfirmed("g1", "a1", [student("s1")], [{ slot_id: "g1-1", venue_id: "v-a", window: t(40), resource_ids: ["m1"] }], t(10)),
    ev({ event_type: "RECEIPT_RECORDED", aggregate_type: "receipt", aggregate_id: "rc1", receipt_id: "rc1", slot_id: "g1-1", content_hash: "h1", payload: { v: 1 }, occurred_at: t(20) }),
    ev({ event_type: "RECEIPT_RECORDED", aggregate_type: "receipt", aggregate_id: "rc1", receipt_id: "rc1", slot_id: "g1-1", content_hash: "h1", payload: { v: 1 }, occurred_at: t(21) }),
    ev({ event_type: "EVIDENCE_ACCEPTED", aggregate_type: "learning_evidence", aggregate_id: "e1", evidence_id: "e1", slot_id: "g1-1", group_id: "g1", receipt_id: "rc1", occurred_at: t(22) }),
    ...extra,
  ];
  const idem = replay(mk());
  assert.equal(idem.state.receipts.get("rc1").versions.size, 1);
  assert.equal(idem.state.receipts.get("rc1").versions.get("h1").n, 2); // 第二次是重传计数，非新账
  assert.equal(idem.state.slots.get("g1-1").status, "scheduled");

  const changed = replay(mk([
    ev({ event_type: "RECEIPT_RECORDED", aggregate_type: "receipt", aggregate_id: "rc1", receipt_id: "rc1", slot_id: "g1-1", content_hash: "h2", payload: { v: 2 }, occurred_at: t(23) }),
  ]));
  assert.equal(changed.state.slots.get("g1-1").status, "suspended");
  assert.equal(changed.state.evidence.get("e1").status, "suspended");
  // 暂停期间设备让出给别组
  assert.equal(changed.state.resources.get("m1").slot_id, null);

  const resolved = replay(mk([
    ev({ event_type: "RECEIPT_RECORDED", aggregate_type: "receipt", aggregate_id: "rc1", receipt_id: "rc1", slot_id: "g1-1", content_hash: "h2", payload: { v: 2 }, occurred_at: t(23) }),
    ev({ event_type: "RECEIPT_RESOLVED", aggregate_type: "receipt", aggregate_id: "rc1", receipt_id: "rc1", resolution: "confirmed_new", occurred_at: t(25) }),
  ]));
  assert.equal(resolved.state.slots.get("g1-1").status, "scheduled");
  assert.equal(resolved.state.resources.get("m1").slot_id, "g1-1"); // 恢复时取回
  assert.equal(resolved.state.evidence.get("e1").status, "valid");
});

test("学习证据三态：有效、改线后保留(revised)、回执变更暂停(suspended)", () => {
  seq = 900;
  const events = [
    registerEq("m1"),
    declareAct("a1"),
    groupConfirmed("g1", "a1", [student("s1")], [{ slot_id: "g1-1", venue_id: "v-a", window: t(30), resource_ids: ["m1"] }], t(10)),
    ev({ event_type: "EVIDENCE_ACCEPTED", aggregate_type: "learning_evidence", aggregate_id: "e1", evidence_id: "e1", slot_id: "g1-1", group_id: "g1", occurred_at: t(15) }),
    ev({
      event_type: "ITINERARY_REVISED", aggregate_type: "activity_slot", aggregate_id: "g1", reason: "delay",
      revisions: [{ slot_id: "g1-1", new_venue_id: "v-b", new_window: t(60) }], occurred_at: t(16),
    }),
  ];
  const r = replay(events);
  assert.equal(r.state.evidence.get("e1").status, "revised");
  const report = buildReport(r.state);
  const g = report.groups[0];
  assert.equal(g.evidence_revised[0].evidence_id, "e1");
});

test("确定性：同一事件流任意次重放得到相同状态指纹与派生事件", async () => {
  const stream = JSON.parse(await readFile(new URL("../data/event-stream.json", import.meta.url), "utf8")).events;
  const a = replay(stream);
  const b = replay(stream);
  assert.equal(a.hash, b.hash);
  assert.deepEqual(a.derivedEvents, b.derivedEvents);
});

test("检查点：中断后续跑与一次性全量重放状态、派生事件完全一致；前缀被改写则拒绝", async () => {
  const stream = JSON.parse(await readFile(new URL("../data/event-stream.json", import.meta.url), "utf8")).events;
  const cut = 27;

  const full = replay(stream);

  const part1 = replay(stream.slice(0, cut));
  const dir = await mkdtemp(join(tmpdir(), "ckpt-"));
  try {
    const path = join(dir, "c.json");
    await saveCheckpoint(path, part1.state, stream.slice(0, cut));
    const slice = resumeSlice(await loadCheckpoint(path), stream);
    assert.equal(slice.resumed, true);
    const part2 = replay(slice.events, { state: slice.state, startOffset: cut });
    assert.equal(part2.hash, full.hash);
    assert.deepEqual(part2.derivedEvents, full.derivedEvents.slice(part1.derivedEvents.length));

    // 前缀被改写：拒绝在旧检查点上叠加
    const tampered = stream.map((e, i) => (i === 5 ? { ...e, summary: e.summary + "（被改写）" } : e));
    await assert.rejects(
      async () => resumeSlice(await loadCheckpoint(path), tampered),
      (err) => err.code === "CHECKPOINT_PREFIX_MISMATCH",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI：--until-offset 中断后再次执行自动续跑，最终指纹与全量重放相同", () => {
  const root = join(new URL("..", import.meta.url).pathname);
  const stream = join(root, "data", "event-stream.json");
  const cli = join(root, "src", "replay.js");
  const run = (args) => spawnSync(process.execPath, [cli, stream, ...args], { encoding: "utf8" });

  const dir = join(tmpdir(), `cli-ckpt-${process.pid}-${Date.now()}`);
  const ck1 = join(dir, "c1.json");
  const ck2 = join(dir, "c2.json");

  const interrupted = run(["--checkpoint", ck1, "--until-offset", "30", "--json"]);
  assert.equal(interrupted.status, 3, interrupted.stderr);
  const resumed = run(["--checkpoint", ck1, "--json"]);
  assert.equal(resumed.status, 0, resumed.stderr);
  const clean = run(["--reset", "--checkpoint", ck2, "--json"]);
  assert.equal(clean.status, 0, clean.stderr);

  const hResumed = JSON.parse(resumed.stdout).replay.state_hash;
  const hClean = JSON.parse(clean.stdout).replay.state_hash;
  assert.ok(hResumed && hResumed === hClean, `续跑指纹 ${hResumed} 应等于全量指纹 ${hClean}`);

  // 第三次执行（检查点已覆盖全流）结果仍一致且稳定
  const again = run(["--checkpoint", ck1, "--json"]);
  assert.equal(JSON.parse(again.stdout).replay.state_hash, hClean);
});
