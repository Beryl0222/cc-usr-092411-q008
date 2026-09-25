#!/usr/bin/env node
// 命令入口：确定性重放一条研学多馆延误事件流。
//
// 用法：
//   node src/replay.js <事件流.json> [选项]
//
// 选项：
//   --checkpoint <路径>   指定检查点文件（默认按事件流路径派生的临时文件）
//   --report <路径>       报告写入文件；缺省输出到 stdout
//   --stop-after <N>      应用前 N 条记录后保存检查点并退出（模拟进程中断）
//   --reset               忽略已有检查点，从第 0 条重放
//
// 退出码：0 正常；2 参数/输入错误；3 在 --stop-after 处挂起（检查点已落盘）

import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { applyEvent, buildReport, createInitialState, stableStringify } from "./engine.js";
import { buildCheckpoint, defaultCheckpointPath, saveCheckpoint, verifyAndRestore } from "./checkpoint.js";
import { validateEvent } from "./validator.js";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const name = token.slice(2);
      if (name === "reset") {
        args.reset = true;
      } else {
        args[name] = argv[(i += 1)];
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

async function loadEvents(path) {
  const raw = JSON.parse(await readFile(path, "utf8"));
  const events = Array.isArray(raw) ? raw : raw.events;
  if (!Array.isArray(events)) {
    throw new Error("事件流文件须为事件数组，或含 events 数组的对象");
  }
  for (const [idx, event] of events.entries()) {
    const errors = validateEvent(event);
    if (errors.length > 0) throw new Error(`第 ${idx + 1} 条事件信封不合法：${errors.join("；")}`);
  }
  return events;
}

// 确定性美化输出：先经 stableStringify 排序键，再解析回对象做缩进打印。
function deterministicPretty(value) {
  return JSON.stringify(JSON.parse(stableStringify(value)), null, 2);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const streamPath = args._[0];
  if (!streamPath) {
    process.stderr.write("用法：node src/replay.js <事件流.json> [--checkpoint 路径] [--report 路径] [--stop-after N] [--reset]\n");
    process.exit(2);
  }
  const absoluteStream = resolve(streamPath);
  const checkpointPath = args.checkpoint ? resolve(args.checkpoint) : defaultCheckpointPath(absoluteStream);
  const stopAfter = args["stop-after"] !== undefined ? Number(args["stop-after"]) : null;
  if (stopAfter !== null && (!Number.isInteger(stopAfter) || stopAfter < 0)) {
    process.stderr.write("--stop-after 必须是非负整数\n");
    process.exit(2);
  }

  const events = await loadEvents(absoluteStream);

  let state;
  let resumedFrom = 0;
  let checkpointExisted = false;
  if (!args.reset) {
    try {
      const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
      state = verifyAndRestore(checkpoint, events);
      resumedFrom = state.seq;
      checkpointExisted = true;
    } catch (error) {
      if (error.code !== "ENOENT") {
        process.stderr.write(`检查点不可用：${error.message}\n`);
        process.exit(2);
      }
      state = createInitialState();
    }
  } else {
    state = createInitialState();
    await rm(checkpointPath, { force: true });
  }

  const appliedNow = { value: 0 };
  const duplicates = { value: 0 };
  let suspended = false;

  for (let i = state.seq; i < events.length; i += 1) {
    if (stopAfter !== null && state.seq >= stopAfter) {
      suspended = true;
      break;
    }
    const result = applyEvent(state, events[i]);
    appliedNow.value += 1;
    if (result === "duplicate") duplicates.value += 1;
  }
  if (stopAfter !== null && state.seq === stopAfter && state.seq < events.length) {
    suspended = true;
  }

  // 检查点始终落盘：完整跑完后保存终态，再跑一次即全部命中续跑，报告仍一致。
  await saveCheckpoint(buildCheckpoint(state, events), checkpointPath);

  const report = {
    ...buildReport(state),
    replay: {
      stream: absoluteStream,
      total_records: events.length,
      resumed_from_seq: resumedFrom,
      checkpoint_used: checkpointExisted,
      checkpoint_path: checkpointPath,
      applied_this_run: appliedNow.value,
      duplicate_records_this_run: duplicates.value,
      suspended,
      remaining_records: events.length - state.seq,
    },
  };

  const output = `${deterministicPretty(report)}\n`;
  if (args.report) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(resolve(args.report), output, "utf8");
    process.stderr.write(
      `报告已写入 ${args.report}（从检查点 ${resumedFrom} 续跑，本次应用 ${appliedNow.value} 条，剩余 ${events.length - state.seq} 条）\n`,
    );
  } else {
    process.stdout.write(output);
  }

  if (suspended) process.exit(3);
}

main().catch((error) => {
  process.stderr.write(`重放失败：${error.message}\n`);
  process.exit(2);
});
