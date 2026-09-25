// 检查点存储：进程中断后从"未完成检查点"继续。
// 检查点内容 = 重放至某条事件后的完整状态快照 + 已消费事件流前缀的指纹。
// 再次重放时校验流前缀逐字节一致（event_id 序列与顺序哈希），不一致则拒绝续跑，
// 强制从偏移 0 全量重放，避免在被改写的历史上叠加状态。

import { writeFile, rename, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { serializeState, hydrate, fnv1a, canonical } from "./engine.js";

export function prefixFingerprint(events) {
  // 逐事件指纹：既锁定标识与顺序，也锁定内容（事件不可原地改写，更正须产生后继记录）
  const lines = events.map((e) => `${e.event_id}\t${fnv1a(canonical(e))}`);
  return { count: events.length, hash: fnv1a(lines.join("\n")) };
}

export async function saveCheckpoint(path, state, events, meta = {}) {
  const fp = prefixFingerprint(events);
  const checkpoint = {
    format: "study-tour-lab-orchestration/checkpoint@1",
    saved_at: new Date().toISOString(),
    prefix: fp,
    next_offset: events.length,
    state: serializeState(state),
    ...meta,
  };
  const tmp = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, JSON.stringify(checkpoint, null, 2), "utf8");
  await rename(tmp, path); // 同目录原子替换：中断不会留下半截检查点
  return checkpoint;
}

export async function loadCheckpoint(path) {
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    return raw;
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

// 返回可直接传给 replay() 的续跑切片；前缀不符或检查点覆盖全流时给出明确信号。
export function resumeSlice(checkpoint, events) {
  if (!checkpoint) return { state: null, events, startOffset: 0, resumed: false };
  const fp = prefixFingerprint(events.slice(0, checkpoint.next_offset));
  if (fp.count !== checkpoint.prefix.count || fp.hash !== checkpoint.prefix.hash) {
    const err = new Error(
      `检查点前缀不一致（检查点 ${checkpoint.prefix.count} 条/${checkpoint.prefix.hash}，当前流前 ${checkpoint.next_offset} 条/${fp.hash}）；`
      + "输入事件流被改写，请删除检查点后从偏移 0 全量重放。",
    );
    err.code = "CHECKPOINT_PREFIX_MISMATCH";
    throw err;
  }
  return {
    state: hydrate(checkpoint.state),
    events: events.slice(checkpoint.next_offset),
    startOffset: checkpoint.next_offset,
    resumed: true,
  };
}
