#!/usr/bin/env node
// 命令入口：确定性重放一条多馆延误事件流。
//
// 用法：
//   node src/replay.js [事件流.json] [--checkpoint 路径] [--reset]
//        [--until-offset N] [--json] [--no-save]
//
// - 默认从与流配套的检查点续跑（流前缀指纹一致才允许续，见 checkpoint.js）；
// - --until-offset N 只放完前 N 条输入事件并落检查点，用于模拟进程中断；
// - 再次执行（不带 --until-offset）从未完成检查点继续，最终状态指纹与一次性全量重放相同。

import { readFile } from "node:fs/promises";
import { resolve, join, basename } from "node:path";

import { replay, stateHash, EngineError } from "./engine.js";
import { buildReport, renderText } from "./report.js";
import { loadCheckpoint, saveCheckpoint, resumeSlice } from "./checkpoint.js";

function parseArgs(argv) {
  const args = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (key === "reset" || key === "json" || key === "no-save") args.flags[key] = true;
      else args.flags[key] = argv[(i += 1)];
    } else args.positional.push(a);
  }
  return args;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const streamPath = resolve(positional[0] ?? "data/event-stream.json");
  const ckptPath = resolve(flags.checkpoint
    ?? join(".replay", `${basename(streamPath)}.checkpoint.json`));

  const raw = JSON.parse(await readFile(streamPath, "utf8"));
  const events = Array.isArray(raw) ? raw : raw.events;
  if (!Array.isArray(events)) throw new Error("事件流必须是数组或 { events: [...] }");

  let checkpoint = flags.reset ? null : await loadCheckpoint(ckptPath);
  let slice;
  try {
    slice = resumeSlice(checkpoint, events);
  } catch (err) {
    if (err.code === "CHECKPOINT_PREFIX_MISMATCH") {
      console.error(`拒绝续跑：${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  const startOffset = slice.startOffset;
  let toProcess = slice.events;
  let complete = true;
  if (flags["until-offset"] !== undefined) {
    const until = Number(flags["until-offset"]);
    if (!Number.isInteger(until) || until < startOffset) {
      console.error(`--until-offset 必须是 >= ${startOffset} 的整数（检查点已放到该偏移）`);
      process.exit(2);
    }
    toProcess = slice.events.slice(0, until - startOffset);
    complete = until >= events.length;
  }

  const result = replay(toProcess, { state: slice.state ?? undefined, startOffset });
  const consumedThisRun = toProcess.length;
  const globalConsumed = startOffset + consumedThisRun;
  const isComplete = complete && globalConsumed >= events.length;

  const priorDerived = checkpoint?.derived_events ?? [];
  const derivedEvents = [...priorDerived, ...result.derivedEvents];

  if (!flags["no-save"] && consumedThisRun > 0) {
    await saveCheckpoint(ckptPath, result.state, events.slice(0, globalConsumed), {
      derived_events: derivedEvents,
    });
  }

  if (slice.resumed) {
    console.error(`从检查点续跑：偏移 ${startOffset} → ${globalConsumed}（${ckptPath}）`);
  } else if (!isComplete) {
    console.error(`已落未完成检查点：偏移 ${globalConsumed}/${events.length}（${ckptPath}）`);
  }

  const report = buildReport(result.state, {
    processedCount: globalConsumed,
    derivedCount: derivedEvents.length,
    complete: isComplete,
    stateHash: result.hash,
  });

  if (flags.json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderText(report));

  if (!isComplete) process.exitCode = 3; // 约定：3 = 流尚未放完（中断/截断）
}

main().catch((err) => {
  if (err instanceof EngineError) {
    console.error(`编排拒绝（${err.code}）：${err.message}`);
    process.exit(1);
  }
  console.error(err.stack ?? err.message);
  process.exit(1);
});
