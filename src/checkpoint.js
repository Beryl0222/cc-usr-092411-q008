// 检查点存储：快照 + 事件流指纹。
//
// 续跑正确性由两层指纹保证：
// - stream_fingerprint：整条事件流（顺序+内容）的哈希。检查点只对这一条流有效，流被改动即拒续。
// - prefix_fingerprint：前 events_count 条事件的哈希。恢复后重新计算前缀核对，防止快照与流错位。
// 写入采用临时文件 + rename 的原子替换，进程中断不会留下半截检查点。

import { rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";

import { createInitialState, restoreState, snapshotOf, stableStringify, streamFingerprint } from "./engine.js";

const CHECKPOINT_VERSION = 1;

function fileFingerprint(path) {
  return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

export function defaultCheckpointPath(streamPath) {
  return join(tmpdir(), `study-tour-replay-${fileFingerprint(streamPath)}.ckpt.json`);
}

export function buildCheckpoint(state, events) {
  const count = state.seq;
  return {
    checkpoint_version: CHECKPOINT_VERSION,
    events_count: count,
    stream_fingerprint: streamFingerprint(events),
    prefix_fingerprint: streamFingerprint(events, count),
    saved_at_event_seq: count,
    state: snapshotOf(state),
  };
}

export async function saveCheckpoint(checkpoint, path) {
  const tmp = join(dirnameOf(path), `.${basename(path)}.tmp-${process.pid}`);
  await writeFile(tmp, stableStringify(checkpoint), "utf8");
  await rename(tmp, path); // 同目录原子替换
}

function dirnameOf(path) {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(0, idx) : ".";
}

export function verifyAndRestore(checkpoint, events) {
  if (checkpoint.checkpoint_version !== CHECKPOINT_VERSION) {
    throw new Error(`检查点版本 ${checkpoint.checkpoint_version} 不受支持`);
  }
  const full = streamFingerprint(events);
  if (full !== checkpoint.stream_fingerprint) {
    throw new Error(
      "事件流指纹与检查点不一致：流内容或顺序已变化，拒绝在旧检查点上续跑（请删除检查点后从头重放）",
    );
  }
  const prefix = streamFingerprint(events, checkpoint.events_count);
  if (prefix !== checkpoint.prefix_fingerprint) {
    throw new Error("检查点前缀指纹不匹配：快照与事件流错位，拒绝续跑");
  }
  const state = restoreState(checkpoint.state);
  if (state.seq !== checkpoint.events_count) {
    throw new Error("检查点内部不一致：state.seq 与 events_count 不符");
  }
  return state;
}

export function freshState() {
  return createInitialState();
}
