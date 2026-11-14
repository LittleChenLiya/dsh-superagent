# 自主推进台账

> 依据：`docs/PROGRESS.md` + `C:\Users\18375\Documents\Trae-CN\temp_20261114_25\dsh-superagent-对照调研.md` 第 6 节。
> 规则：按清单顺序推进；每累计完成 3 项（或准备发版前）另起对抗审查会话；不自行发布 npm 版本。

## 基线
- 第 1 项（发布阻断：`files` 补 `lib/memory.js` / `notify.js` / `lock.js`，测试脚本补 memory 用例）已完成，测试 106 → 130。
- 已发布版本：0.9.3（先前轮次完成，本轮不发布、不改 version、不打 tag）。

## 已完成计数（用于触发对抗审查）
- 自本轮起累计：8 / 3（第 2 项本轮完成；第 3/4/5/6/7/8/9 项由并行会话在 round 11 完成，见 `docs/PROGRESS.md`）
- 触发状态：**已触发**，对抗审查会话于 2026-11-15 派发（只读挑刺，不改代码）。

## 轮次 1 — 2026-11-15

### 派发任务：第 6 节第 2 项「派发幂等」
范围：goal 归一化 + `dedupeKey`，同一件事不重复派发。不做第 3 项及以后。

验收标准：
1. 归一化：去首尾空白、内部连续空白折叠、忽略大小写；据归一化 goal 算 `dedupeKey`；空 goal 的 `no-goal` 行为不变。
2. 命中活跃 run（planning / running / aggregating）时，第二次 `superagent_start` 返回原 run id + `deduped: true`，不新建 run、不 spawn、不额外消耗配额。
3. 去重检查在 start 串行门与文件锁内、以磁盘 run 列表为准，跨进程共享 stateDir 同样只产生一个 run。
4. 并发双开只留一个（有测试证明）。
5. 终态 run 不阻止相同 goal 重新启动；不同 goal 各自建 run。
6. `npm test` 130 项全绿 + 新增 ≥4 条覆盖上述行为；连续两遍全绿；离线。
7. 文档：`docs/PROGRESS.md` 新节、`README.md` 工具说明、`CHANGELOG.md` Unreleased 段。
8. 不发布、不改 version、不打 tag。

状态：**已完成**。归一化 + `dedupeKey` + 跨进程 per-goal claim；`npm test` 151 全绿、连续两遍、离线。细节与证据见 `docs/PROGRESS.md` 的 2026-11-15 节。

### 核验（2026-11-15）
- 独立复跑 `npm test`：151 / 151 pass，0 fail，离线。
- 代码核对：`normalizeGoal`（trim + 空白折叠 + 小写）、`dedupeKeyOf`（sha256）、`activeRunForGoal`（磁盘 list + 本进程 runtime，仅 ACTIVE_STATUSES）、`withGoalGuard`（per-goal claim 包住 list→check→write，位于 start 串行门内）、`start()` 命中即返回原 run + `deduped: true`（不建 run、不 spawn）。
- `package.json` 仍为 `0.9.3`，未发布、无 tag；工作区干净（3 个 commit：`253f91a` / `f8f2254` / `210bc8a`）。
- 并行会话 round 11 已完成第 3/4/5/6/7/8/9 项（attention、退避+恢复备注、milestones、报告 artifact、human-priority quota、记忆分层、出站保序），已随 `f8f2254` 一并提交；这些项目前记“待对抗审查”，不记达标。

### 对抗审查（2026-11-15，独立只读会话）
- 基线 `4b67a27..HEAD`（3 commit，约 3200 行新增），`npm test` 151/151 两次全绿。
- 结论：**blocker 0；major 5；minor 5**；发版结论 **暂缓**。
- major：attention 换行/超长注入；非法 attention 静默消失；resume 无条件突破配额且无会话归属校验；dedupe 跨 session 串 run；`wait_seconds` 丢失 `deduped`（列在 minor 6）。
- minor：`wait_seconds` 丢 `deduped`；通知折叠批失败后 pending 丢失；`memoryMaxEntries` 与 README 不符；`embedding.md` 配额描述过期 + prune 不清理 `reports/<id>.md`；`DONE.md` 的 clean 声明与实际不符。
- 已确认安全：goal claim 的 `wx` 原子创建与赢家先写后释放、runId 路径逃逸防护、报告原子写、rules/profile 对 run 只读、digest 硬顶、Windows rename 重试。
- 处置：已派发修复会话；修复结果见下方「轮次 2」。仍不发布、不改版本。

### 后续顺序（第 6 节建议）
第 2–9 项均已有实现；剩余为第 10 项「不做」清单，无新增开发项。对抗审查 1–10 条已在轮次 2 修复；下一动作是发布前版本号/README 复核（发布需用户拍板）。

### 前批未提交改动的处理
仓库内 memory / notify / quiet 一批改动在本轮开始前未提交；已要求先跑通 130 项测试再单独提交，避免与幂等改动混在一起。

## 轮次 2 — 2026-11-15 对抗审查修复

对应审查结论 1–10，逐条状态：

1. **已修**：`question` / `options` / `reason` 入库前统一 `replace(/\s+/g, ' ')`，上限 500 / 200 / 300 字符；状态行与通知首行不再可能被换行或伪造 `[superagent]` 行切分。
2. **已修**：单条 option 上限 200 字符（同上函数）；测试断言长度。
3. **已修**：非法 attention 不再剥除——原 fence 保留在报告正文，`run.attention.issue` 记录原因，status 输出 `attention: <reason>`，通知追加 `Attention:` 行；聚合器与 subtask 两条路径都覆盖。
4. **已修**：`resume` 默认计入 `maxActiveRuns`，满额时拒绝并提示；`force: true`（工具）/ `force` 或 `override_quota`（HTTP）显式放行；非 `parentSessionId` 会话一律拒绝，HTTP 映射 `409 wrong-session`。
5. **已修**：`activeRunForGoal` 增加 `parentSessionId` 过滤；同会话同 goal 仍只一个 run + `deduped: true`，跨会话相同 goal 各得一个 run；跨进程 per-goal claim 保留。
6. **已修**：`wait_seconds > 0` 的 start（工具与 HTTP）把瞬态 `deduped` 标记带到 status 快照，输出仍可见。
7. **已修**：`notifyPolicy.restore(batch)` 在发送失败时把折叠批放回 `pending`（按 id 去重，受 `MAX_PENDING` 限制，连续 3 次投递失败才丢弃）；`notifyParent` 的 catch 路径调用。
8. **已修**：`memory.write()` 在追加后超过 `memoryMaxEntries` 时也触发压缩（400 行 / 128 KB 仍是硬上限），调小配置下次写入即生效。
9. **已修**：`docs/embedding.md` 的 resume/quota 描述与代码一致并补 `wrong-session`；`store.prune()` 同步删除 `reports/<runId>.md`。
10. **已修**：`docs/DONE.md` H2 改为诚实的 PENDING（工作区 clean，但 commit 尚未 push）；本轮台账改动与修复同一个 commit。

验证：`npm test` 连续两遍 157 / 157 pass、0 fail、离线；未发布、未改 version（0.9.3）、无 tag。

### 前批未提交改动的处理
仓库内 memory / notify / quiet 一批改动在本轮开始前未提交；已要求先跑通 130 项测试再单独提交，避免与幂等改动混在一起。
