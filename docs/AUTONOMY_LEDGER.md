# 自主推进台账

> 依据：`docs/PROGRESS.md` + `C:\Users\18375\Documents\Trae-CN\temp_20261114_25\dsh-superagent-对照调研.md` 第 6 节。
> 规则：按清单顺序推进；每累计完成 3 项（或准备发版前）另起对抗审查会话；不自行发布 npm 版本。

## 基线
- 第 1 项（发布阻断：`files` 补 `lib/memory.js` / `notify.js` / `lock.js`，测试脚本补 memory 用例）已完成，测试 106 → 130。
- 已发布版本：0.9.3（先前轮次完成，本轮不发布、不改 version、不打 tag）。

## 已完成计数（用于触发对抗审查）
- 自本轮起累计：0 / 3

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

### 后续顺序（第 6 节建议）
2 完成后 → 4（暂时性错误退避 + 恢复备注）→ 3（attention 结构化汇报）→ 5（milestones）→ 8（reports/artifacts）→ 6（人的操作优先，单独一轮）→ 7（记忆分层补齐）→ 9（出站保序）。

### 前批未提交改动的处理
仓库内 memory / notify / quiet 一批改动在本轮开始前未提交；已要求先跑通 130 项测试再单独提交，避免与幂等改动混在一起。
