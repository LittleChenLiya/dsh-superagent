# 长期目标（Long Goal）

一个自然语言目标拆成多个阶段，每个阶段交给一组新的 agent 跨多轮推进；同一时刻可以有多组 agent 并行；宿主重启后从上次未完成的阶段继续，而不是从零重来。

本文是设计与边界说明。实现见 `lib/long-goal.js`，测试见 `test/long-goal.test.mjs`。

## 1. 与现有概念的关系

| 现有概念 | 关系 | 为什么不是替换 |
| --- | --- | --- |
| run | 长期目标的一个阶段执行一次 = 一个普通 run（每次重试也是一个新 run） | run 已经拥有 planner、依赖图、并行 worker、预算、用量、报告、审计、恢复与看板卡片。重写等于把这些再实现一遍，并让 0.14.3 的路径失去回归保护。 |
| 任务线（run 的 subtasks） | 阶段内部的并行任务线仍由 run 的 planner 生成，依赖、写冲突和并行上限沿用现有实现 | 长期目标不重新定义“任务”，只负责“哪些阶段可以同时开始、什么时候进入下一阶段”。 |
| 看板 | 阶段 run 照常出现在看板上；run 的 goal 文本带「长期目标 / 阶段 n/N」前缀，卡片可以直接分辨归属；目标级进度由 `superagent_goal status` 输出 | 不新增第二套看板数据源。看板读 run，goal 读 run 的阶段状态，只有一个事实来源。 |
| 收件箱 | 阶段 run worker 的提问仍走原有 attention / `superagent_answer`；阶段重试耗尽、停滞这类“目标级”问题走 `superagent_goal answer`，并通过 owner 会话的 followup 送达 | 收件箱已经能处理 run 级问题，目标级问题只需要一个新的路由 id，不需要新的消息系统。 |
| goal mode（0.14.3） | 阶段内部开 goal mode：一轮不达标就带着失败证据再来一轮，直到验收成立或硬停 | goal mode 是“同一阶段内的多轮”，长期目标是“多阶段之间的推进”。两者组合，而不是二选一。 |
| 定时计划（schedule） | 不使用。定时计划解决“按时间重复跑”，长期目标解决“一个目标跑到完成” | 把长期目标塞进 schedule 会让计划、窗口、补跑语义混在一起。 |

结论：**扩展，不替换**。新增一个薄的目标层（阶段图 + 目标预算 + 跨阶段恢复），阶段执行完全复用 run。

## 2. 数据结构

长期目标是 `$DSH_HOME/state/superagent/goals/<goalId>.json` 里的一个 JSON 记录，原子写入（临时文件 + rename，Windows 上 EPERM 重试）。阶段 run 仍是 `runs/<runId>.json`，是任务级细节的唯一事实来源。

```jsonc
{
  "id": "g-20261116T101500-4f2a",
  "schemaVersion": 1,
  "goal": "把 dsh-superagent 推进到 1.0：范围、实现、发布验证三个阶段",
  "status": "planning | running | paused | needs-decision | stalled | completed | partial | failed | cancelled | budget-stopped",
  "createdAt": "…", "updatedAt": "…", "startedAt": "…", "finishedAt": null,
  "ownerSessionId": "session-…",          // 阶段 run 的 parent，重启后据此恢复
  "cwd": "D:\\work\\plugin-1.0",           // 阶段验收命令的工作目录
  "autoResume": true,                      // 宿主重启后自动接着跑
  "maxParallelPhases": 2,                  // 同时推进的阶段数
  "maxAttemptsPerPhase": 2,                // 一个阶段最多执行几次（含首次）
  "maxRoundsPerPhase": 3,                  // 阶段 run 内 goal mode 的轮数
  "noProgressRounds": 2,                   // 阶段 run 内连续同条件失败几轮算停滞
  "phaseBudget": { "maxModelCalls": 40, "maxTokens": 800000 },  // 每次阶段 run 的上限
  "budget": { "maxModelCalls": 120, "maxTokens": 3000000 },     // 整个目标的上限；null = 不额外限制
  "maxWallClockMinutes": 1440,
  "stallAfterMinutes": 180,                // 没有阶段完成多久算目标级停滞
  "phases": [{
    "id": "p1",
    "title": "1.0 范围",
    "objective": "盘点现状，写出 1.0 的范围、非目标与验收清单",
    "dependsOn": [],
    "acceptance": [                        // 至少一条；check 省略时由验收模型判断
      { "id": "a1", "text": "docs/ROADMAP-1.0.md 存在且包含验收清单", "check": { "type": "file", "path": "docs/ROADMAP-1.0.md" } }
    ],
    "status": "pending | ready | running | verifying | completed | failed | skipped | cancelled | needs-decision",
    "attempts": 0,
    "runIds": [],                          // 每次尝试的 run；最后一个就是当前/最近一次
    "currentRunId": null,
    "resumeRunId": null,                   // 宿主重启后要恢复的原 run
    "deliverables": [],                    // 可选，用于报告汇总
    "lastOutcome": { "runStatus": null, "error": null, "failed": [], "changed": null },
    "startedAt": null, "finishedAt": null
  }],
  "decomposeRunId": null,                  // 自动拆阶段用的 run
  "decomposeAttempts": 0,
  "decisions": [{
    "id": "d1", "kind": "phase-exhausted | verification-conflict | stalled | worker-question",
    "phaseId": "p2",
    "question": "p2 连续两次失败，是否换一种做法重试？",
    "options": ["retry", "skip", "stop"],
    "reason": "…",
    "answer": null, "answeredAt": null, "createdAt": "…"
  }],
  "decisionSeq": 0,
  "usage": { "modelCalls": 0, "tokens": 0 },  // 所有阶段 run + 拆阶段 run 的合计
  "events": [{ "at": "…", "type": "phase.completed", "phaseId": "p1", "detail": "…" }],
  "progressAt": "…",                        // 最近一次阶段状态前进的时间
  "noProgressAttempts": 0,                  // 自 progressAt 起失败的阶段尝试数
  "stoppedReason": null,
  "recovery": { "at": "…", "reason": "host-restart", "phases": ["p2"] }
}
```

约束：

- 阶段数 1–8；id 必须唯一；`dependsOn` 只能引用已存在的阶段；出现环直接拒绝创建，不落盘半成品。
- 每个阶段至少一条验收条件。用户没写时补一条由验收模型判断的条件（“该阶段目标已经达成，且报告给出可核对证据”）。
- 所有上限只收紧不放大：阶段预算再大也不能超过目标剩余预算。

## 3. 状态机

### 3.1 目标

```
create ──> planning ──> running ──> completed
                │          │  │
                │          │  ├─> partial      （有阶段被人工 skip，其余完成）
                │          │  ├─> failed       （阶段永久失败且人工选择 stop）
                │          │  ├─> stalled      （无进展，等人决定）
                │          │  ├─> needs-decision（有开放式问题/阶段重试耗尽）
                │          │  └─> budget-stopped（目标预算耗尽）
                │          └─> paused ──resume──> running
                └─> failed（拆阶段失败，重试一次后仍不可用；不再重试）
任意状态 ──cancel──> cancelled
```

- `planning`：有 `decomposeRunId` 时只等这个 run；用户显式给了 `phases` 时跳过。
- `running`：每个 tick 结算已完成阶段、启动依赖已满足的阶段，最多 `maxParallelPhases` 个。
- `needs-decision`：至少一个问题未回答。**不启动新阶段**；已经在跑的阶段 run 继续跑完，结果不会丢。
- `paused`：人工暂停或宿主重启后暂时找不到 owner 会话。不启动新阶段。
- `stalled`：目标级停滞。不自动重试，等人选择继续或停止。
- `completed`：所有阶段 completed。
- `partial`：所有阶段进入终态，但有 skipped（人工跳过）或 failed（人工选择继续），其余完成。
- `budget-stopped`：目标预算耗尽，停止派发，不重试。

### 3.2 阶段

```
pending ──依赖完成──> ready ──启动 run──> running ──run 终态──> verifying
                                                  │              │
                                                  │              ├─> completed
                                                  │              ├─> ready（可重试，attempts+1）
                                                  │              ├─> needs-decision（run 在提问）
                                                  │              └─> failed（重试耗尽/不可重试）
pending ──依赖失败/跳过──> skipped
interrupted ──宿主重启──> ready（resumeRunId=原 run，恢复而不是新建）
任意阶段 ──目标取消──> cancelled
```

- `verifying` 是结算瞬间的状态：读 run 的 `goalMode.achieved`、终态、失败条件，决定 completed / retry / needs-decision / failed。
- `ready` + `resumeRunId` 表示“恢复原 run”；没有 `resumeRunId` 才是“新建一次尝试”。
- 阶段 run 的 `status === 'completed'` 在 goal mode 下等价于验收成立；`partial`/`failed` 才进入重试判定。

## 4. 依赖与并行

- 阶段依赖是显式的 `dependsOn`。只有全部依赖 `completed` 才变 `ready`；依赖 `failed`/`skipped` 的阶段直接 `skipped`（级联，不重跑）。
- 同一 tick 可以启动多个互不依赖的阶段；上限 `maxParallelPhases`，同时受 `maxActiveRuns` 约束（超出的阶段 run 排队，不丢）。
- 阶段内部的任务线并行仍由 run 的 `maxParallel` 与写冲突检测负责。长期目标不提高这个值。
- 阶段 run 的 goal 文本带阶段编号和已完成阶段的结论摘要，后续阶段能读到前序产出，不需要共享内存。

## 5. 预算

三层，全部是硬停：

1. **目标预算** `budget`：所有阶段 run、拆阶段 run、重试 run 的用量合计。达到即 `budget-stopped`，不再派发。
2. **阶段预算** `phaseBudget`：每个阶段 run 自己的一次上限（goal mode 的 `budget`，同时进入 run limits）。跑飞只影响一个阶段，不会烧穿整个目标。
3. **阶段内轮次** `maxRoundsPerPhase` + `maxWallClockMinutes`：由 goal mode 执行，防止同一阶段无限重来。

派发前计算 `remaining = budget - spent`，把阶段预算收紧到 `min(phaseBudget, remaining)`。剩余为 0 时不启动。

## 6. 停滞检测

两层，分别回答“这个阶段是不是在原地打转”和“整个目标是不是没有前进”。

阶段级（复用 goal mode 的 `assessRound`）：

- 有机器验收且这一轮没有改动任何文件 → `no-changes`，阶段 run 立即停。
- 同一个失败条件连续 `noProgressRounds` 轮 → `no-progress`。
- 这两种结果都进入阶段重试；重试指令必须写清“上一轮失败在哪个条件、下一步改什么”，不允许只写“再试一次”。

目标级：

- `progressAt` 只在阶段 completed、skipped 或人工回答后前进。
- 距 `progressAt` 超过 `stallAfterMinutes`，或连续 `maxAttemptsPerPhase * 2` 次阶段尝试都没有带来阶段完成 → `stalled`，写一条 decision（选项：`continue` / `stop`），**不自动重试**。
- 没有 running 阶段、也没有 ready 阶段，剩余阶段全部被失败/跳过依赖卡死 → `failed`（死锁不可通过等待解决）。

## 7. 人工介入点

必须问人：

- 阶段重试耗尽：`phase-exhausted`，选项 `retry`（带一句新指示，重置尝试次数并新建 run）/ `skip`（级联跳过下游）/ `stop`。
- 目标级停滞：`stalled`，选项 `continue`（重置停滞计数，允许再推进）/ `stop`。
- 阶段 run 的 worker 主动提问（attention）：目标转 `needs-decision`，问题原文和 `runId/attentionId` 一起显示，用现有 `superagent_answer` 回答；目标层不复制一份问题。
- 验收证据互相矛盾：`verification-conflict`，选项 `accept`（以机器校验为准，计为完成）/ `retry`（换人重试）/ `stop`。两个方向都不算达成：
  - 机器校验通过、但 worker 自己的结论是否定的（held / failed / 明说没能验证，例如 worker shell 里 `spawn EPERM` 而宿主进程里同一命令 exit 0）；
  - 机器校验失败、但 worker 或验收模型声称成功（exit code 是事实，不是意见）。
  decision 的 `source.worker` 保存 worker 原话，`source.machine` 保存命令、`exitCode`、`detail`，便于人工对照。
- 权限策略拦截/需要审批：按不可重试失败处理，等人通过现有审批卡批准后回答 `retry`。
- 宿主重启后原会话无法恢复：`paused`，等人从新会话 `superagent_goal resume`。

直接失败、不重试：

- 拆阶段返回的计划不可解析/不合法，修复一次后仍不合法 → `failed`。
- 阶段依赖有环、引用不存在的阶段 → 创建时直接报错，不创建目标。
- 目标预算耗尽 → `budget-stopped`，不靠重试绕过。
- 显式拒绝（权限、能力缺失）→ 阶段 `failed`，不自动重试；是否继续由人决定。
- 用户 `cancel` → `cancelled`；用户 `pause` → `paused`。

## 8. 重启恢复

持久化的是目标记录 + 每个阶段引用的 run id；任务级细节不复制。

宿主启动顺序：

1. `orchestrator.recover()` 把上一个进程遗留的活跃 run 标记为 `interrupted`，并释放 run 锁。
2. `longGoal.init()` 读取所有目标；对 `autoResume` 且状态为 `planning/running` 的目标：
   - 阶段 `currentRunId` 对应 run 是 `interrupted` → 阶段置 `ready`，记 `resumeRunId`；目标保持 `running`，写 `recovery`。
   - 拆阶段 run 是 `interrupted` → 保留 id，下一 tick 恢复同一个 run（不重新拆）。
   - 阶段 run 已经 `completed` 但目标没来得及记账（崩溃窗口）→ 直接记阶段完成并推进。
3. tick 解析 owner 会话（与 schedule 相同的恢复顺序：live → resume 持久会话 → create 新会话）。解析成功才恢复/启动 run；失败则目标 `paused`，不猜。
4. 恢复阶段 run 用 `orchestrator.resume(runId)`：已完成的 subtask 保持完成，只继续没做完的，**不会重跑已完成的阶段**。
5. 每个目标在派发/恢复时持有 `goals/<id>.lock`（`acquireFileLock`，死进程可回收），避免两个宿主进程同时推进同一目标。

## 9. 工具面

一个工具，动作枚举：

- `superagent_goal action=create goal=... [phases=[...]] [budget=...] [phase_budget=...] ...`
- `superagent_goal action=status goal_id=...`
- `superagent_goal action=list`
- `superagent_goal action=answer goal_id=... decision_id=... answer=retry|skip|stop|continue [note=...]`
- `superagent_goal action=resume|pause|cancel goal_id=...`

阶段 run 继续用 `superagent_status` / `superagent_cancel` / `superagent_answer` 观察和操作。

## 10. 进度可见

- `superagent_goal status` 输出：目标状态、每个阶段的 status/attempts/runId、当前 run 的进度行、验收通过数、下一步。
- 每个阶段完成、进入 needs-decision、目标完成/停止时，向 owner 会话发一条 followup（走现有 outbox，不另建消息通道）。
- 阶段 run 本身在看板上有卡片；goal 文本前缀让卡片能归属到阶段。
- 不做截图式“证明”：验收结论以 run 文件里的 exit code、`goalMode.checks` 和 goal JSON 的阶段状态为准。

## 11. 本期不做

- 不做独立的长期目标看板页面；复用 run 卡片 + status。
- 不做跨目标共享记忆/知识库；阶段之间的上下文通过阶段 goal 文本里的前序摘要传递。
- 不修改宿主源码，不改变沙箱/权限默认值，不为跑通放宽审批。
- 不碰 0.14.3 的发布路径；新代码在 `feat/long-goal` 分支，合并等发布完成后再定。
