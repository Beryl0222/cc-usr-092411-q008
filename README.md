# 研学实操资源编排

上游场馆延迟开放时，把分组、资源、活动、行程修订和学习证据事件串成**可执行、可确定性重放**的实验编排。

## 解决什么问题

项目经理最难处理的不是改一张行程表，而是同时判断：哪些小组已经消耗试剂、哪些显微设备仍在运输、哪些高风险学生只能改做替代实验。本服务以事件溯源方式给出确定答案：

- **活动先声明、确认后才预占**：活动声明携带人数上限、技能前置、耗材批次与单组用量、安全等级；`GROUP_CONFIRMED` 之后才预占设备、指导员和场馆时间窗。
- **高风险学生由安全教师签署，不取消整组**：不满足安全/技能门槛的学生进入 `pending_alternative`，原环节在签署前不得开始；`ALTERNATIVE_APPROVED`（必须带 `safety_teacher`）为其建立替代实验环节。`whole_group_cancelled` 在任何路径下恒为 false。
- **延误只迁移后续安排**：已开始/完成的环节拒绝迁移，现场进度与实际耗材消耗原样保留；只改线未开始环节。
- **可解释的公平候补**：同一目标场馆时间窗冲突时，按「确认事件偏移 → 环节序号 → 环节编号」排序，候补原因（被哪个环节占位 / 场馆何时开放）随派生事件落账；窗口空出时队首递进、不跳号。
- **易耗品只扣一次、不重复返还**：环节开始时按批次扣账（`consumedBySlot` 记录每个环节的扣账），开始事件重传不重复扣，改线/释放/完成都不回补库存。
- **现场回执幂等 + 变更暂停**：`(receipt_id, content_hash)` 相同的重传不重复入账；同编号内容变化（新版本）暂停依赖它的后续环节与学习证据，让出可复用设备；`RECEIPT_RESOLVED=confirmed_new` 后环节恢复并优先取回设备，`voided` 时保持暂停等待人工重排。
- **学习证据不删除**：证据状态为 `valid` / `revised`（环节改线，随修订保留）/ `suspended`（依赖回执变更，待核验）。

## 目录

- `contracts/domain.schema.json`：领域事件信封、事件类型与聚合类型枚举。
- `data/event-stream.json`：多馆延误样例事件流（A/C 两馆延误、运输中显微镜、公平候补、回执重传与变更、安全替代）。
- `src/validator.js`：基础事件信封校验。
- `src/engine.js`：纯函数重放引擎（输入不可变事件数组 → 投影状态 + 确定性派生事件）。
- `src/report.js`：项目经理只读投影与文本渲染（每组改线原因、资源余量、学习证据三态）。
- `src/checkpoint.js`：检查点原子写、流前缀指纹校验与续跑切片。
- `src/replay.js`：命令入口。
- `tests/`：契约一致性与 13 项编排规则测试。

## 命令入口

```bash
# 全量确定性重放（默认检查点 .replay/<流名>.checkpoint.json）
npm run replay

# 文本报告
node src/replay.js data/event-stream.json --reset

# 机器可读报告（含每组 reroute_reasons、resource_balances、证据三态、state_hash）
node src/replay.js data/event-stream.json --reset --json
```

模拟进程中断并续跑：

```bash
# 放到第 30 条后中断（退出码 3 = 流未放完，检查点已落盘）
node src/replay.js data/event-stream.json --checkpoint /tmp/c.json --until-offset 30

# 再次执行：从未完成检查点继续
node src/replay.js data/event-stream.json --checkpoint /tmp/c.json

# 续跑最终状态指纹与一次性全量重放（--reset）完全相同
```

参数：`--checkpoint <路径>`、`--reset`（忽略检查点从偏移 0 重放）、`--until-offset N`（截断到第 N 条，模拟中断）、`--json`、`--no-save`。

## 确定性与检查点语义

- 引擎不读时钟、不依赖 Map 插入序以外的环境状态；派生事件 `event_id` 为 `derived:<类型>:<聚合>:<触发偏移>:<序号>`，`occurred_at` 在触发事件时间上叠加随检查点持久化的单调序号。任意次重放同一事件流，状态指纹（FNV-1a 规范化哈希）与派生事件序列一致。
- 检查点 = 完整状态快照 + 已消费事件**前缀指纹**（逐事件的 `event_id + 规范化内容哈希`）。续跑时逐字节校验前缀：事件被原地改写（即使只改 `summary`）会以 `CHECKPOINT_PREFIX_MISMATCH` 拒绝，必须从偏移 0 全量重放——业务更正应产生后继事件，而不是改写历史。
- 检查点临时文件同目录 `rename` 原子替换，中断不会留下半截快照。

## 事件目录（输入事件）

`RESOURCE_REGISTERED`（设备/指导员/场馆窗或耗材批次，含 `in_transit` 状态）、`RESOURCE_STATUS_UPDATED`（运输到场自动补位）、`ACTIVITY_DECLARED`、`GROUP_CONFIRMED`、`RESOURCE_ALLOCATED`/`RESOURCE_RELEASED`、`ACTIVITY_STARTED`/`ACTIVITY_COMPLETED`、`VENUE_DELAYED`、`ITINERARY_REVISED`、`RECEIPT_RECORDED`/`RECEIPT_RESOLVED`、`ALTERNATIVE_APPROVED`、`EVIDENCE_ACCEPTED`。

引擎在重放中确定性派生 `RESOURCE_ALLOCATED/RELEASED`、`SLOT_WAITLISTED`、`SLOT_SUSPENDED`、改线型 `ITINERARY_REVISED` 等事件；`derived:` 前缀的事件不接受外部注入。

## 领域边界

事件一旦被接收，其标识、发生时间和版本不应被原地改写；现场内容更正（如回执换版）必须产生后继记录。涉及个人、机构或商业敏感信息时，调用方只读取完成职责所必需的字段。

## 本地检查

```bash
npm test     # node --test
npm run build # 全部源文件语法检查
```
