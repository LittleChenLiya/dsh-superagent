# 施工单：把执行内核接到用户手指上

> 结论：内核（run、并行调度、依赖、审批桥、产物校验、审计）约八成可用；用户能触达的那一层只有约三成半。
> 本文件不是需求池，是施工单。每条都有现状证据、可感知后果、改造要点和能验收的标准。
>
> 行号基于 2026-11-17 的 `0.16.10` 工作树；改动后行号会漂，以符号名和路由名为主锚点。

## 优先级总表

| 序 | 缺口 | 级别 | 依赖 |
|---|---|---|---|
| 1 | 控制台 20 条路由没有面板入口 | P0 | 无 |
| 2 | 「等你决定」在面板不可见、不可答 | P0 | 1 |
| 3 | 停止键只停 turn，不停 run | P0 | 1 |
| 4 | 审批生命周期随面板关闭被取消；默认权限让审批成摆设 | P1 | 1 |
| 5 | 产物卡缺失 | P1 | 1 |
| 6 | 8 个常驻工具 + 指导语对宿主所有会话生效，worker 未按深度门控 | P1 | 无 |
| 7 | 自建 cron 未接宿主 `ctx.schedule`；守卫误杀 `node -e` | P1 | 无 |

---

## 1. 控制台能力无入口（P0）

**现状**

- 宿主侧已经把发现路由和同源中继都注册好了：
  - [`/superagent/console-address`](../lib/index.js) 在 `lib/index.js:4155`，返回 `{ready, url, token, reason}`。
  - 同源中继 `/superagent/api` → `/api` 在 `lib/index.js:4181-4185`，由 `lib/console.js` 的 `proxy()`（`lib/console.js:1524`）转发并注入 Bearer token。
- 浏览器半边确实在用中继（`lib/client.js:32` 的 `API = '/superagent/api/console'`），但只用了 5 条：
  - `state`（`lib/client.js:869`）、`events`（`893`）、`message`（`938`）、`approval`（`957`）、`cancel`（`972`）。
- `lib/console.js` 已实现但面板零调用的路由（20 条，按能力归类）：
  - 会话：`session`（新建，`:1200`）、`sessions`（历史，`:1207`）、`session/switch`（切换，`:1233`）、`bootstrap`（`1193`）
  - 调度：`runs`（`:1435`）、`runs/:id`（`:1445`）、`runs/:id/cancel`（`:1415`）、`schedules`（`:1222`）
  - 交互：`answer`（回答待决策，`:1343`）、`approval`（`:1310`）、`upload`（`:1298`）
  - 产物：`artifact`（`:1112`）、`serveArtifact()`（`:898`）
  - 只读：`health`（`1126`）、`state`（`1144`）、`tools`（`1173`）、`notices/read`（`1152`）
  - 运维：`wizard/{status,preview,save,rollback,trial}`（`1368`）
- 独立的控制台页 `public/console.html` 已经把这些能力全部画出来了（会话历史 `:2657`、待决策 `:1626`、run 取消 `:2221`、产物 `:2302`），但它是另一个页面；面板里没有任何链接或按钮通向它。
- 标题栏只有「超级智能体」面包屑和任务栏开合（`lib/client.js:539-555`）；没有会话按钮。

**用户可感知的后果**

用户打开「超级智能体」后只能看到一条当前对话和只读的任务线列表。不能新建对话、不能切回上一轮、看不到历史、不能上传文件、打不开产物、也看不到子任务详情。功能存在但等于不存在。

**改造要点**

- 入口二选一，优先做同源中继（已经存在，不需要 token）：
  - 方案 A（推荐）：面板直接扩中继调用，不引入 iframe。
  - 方案 B：标题栏加「打开完整控制台」，点击时 `GET /superagent/console-address` 拿 `url+token`，新开窗口打开 `url?token=…`。仅在方案 A 来不及覆盖 wizard 时作为兜底。
- 标题栏新增「会话」按钮，点开左侧抽屉/弹出层：当前会话、历史会话（标题、轮数、产物数）、「新对话」。
- 新建 = `POST /session`；切换 = `POST /session/switch`，随后重建 `state` 与事件流（现有 `session` 帧处理在 `lib/client.js:496-498` 可以复用）。
- 历史条目点击即切换，不再二次确认。
- 上传入口沿用拖拽 + 输入框旁一个「+」；用户此前反对的是「放进工作区」那种显式按钮，不是上传本身。上传成功后把返回路径写进输入框（`POST /upload`）。
- 产物预览：见第 5 条。

**验收**

1. 从侧栏「超级智能体」进面板后：点「会话」1 步看到列表；「新对话」1 步完成；切回历史 2 步完成；上传 2 步完成（拖入或点「+」）。
2. 浏览器 Network 面板（或 `test/client-entries.test.mjs` 的静态断言）必须能看到 `/sessions`、`/session`、`/session/switch`、`/upload` 四个路径被 client 代码引用。
3. 新建后 `GET /state` 的 `sessionId` 变化；切换后事件流 `hello.sessionId` 同步变化，消息区不残留上一条会话内容。
4. 面板在 `consolePort` 未开时仍按现有错误态降级（`lib/client.js:797-807`），不白屏。

---

## 2. 「等你决定」不可达（P0）

**现状**

- 宿主状态里已有完整数据：`lib/index.js:3536-3543` 把未回答的 `attention.items` 映射为 `openAttention`，`lib/index.js:3607` 放进每个 run 的 `attention` 字段。
- 独立控制台页会渲染成卡片：`public/console.html:1626`（生成 `run:…:attention`）、`:1922`（状态灯「等你决定」）、`:2571`（新问题提示）。
- 面板的 model 里只有 `messages/approvals/runs`（`lib/client.js:306-323`），`Rail` 只读 `run.status/goal`（`lib/client.js:728-746`），全文件没有 `attention` 字样。
- 面板也没有 `answer` 动作：`actions` 只有 `send/decide/cancel/retry/toast`（`lib/client.js:924-983`）。

**用户可感知的后果**

子任务问了问题、或计划需要人确认时，面板一直显示「运行中」，用户永远不知道它在等自己。等到超时后 run 才失败，用户还得从头再来。

**改造要点**

- `state.runs[].attention` 和 `runs` SSE 帧里带出的 `attention` 一并进入 model；任务行状态加一档 `waiting`（黄色）。
- 主列插入问答卡：问题文本、`attentionId`、输入框 + 「回答」；提交走 `POST /answer {runId, attentionId, answer}`。
- 计划确认做成同一种卡：`attention.issue`/`items` 里 `kind = plan` 时按钮为「按计划开始 / 改一下」，改一下直接回填到输入框。
- 未读计数进标题栏，规则与控制台页一致（只记已读 id，`POST /notices/read`）。

**验收**

1. 用一个会提问的 prompt（例如「先问我目标目录再动手」）起 run，面板 5 秒内出现问答卡，任务行变黄。
2. 回答后 `POST /answer` 返回 200，`runs` 帧里该 `attention` 消失，任务行回到绿色。
3. 面板不聚焦时，标题栏未读计数 +1；点开后归零。
4. `test/client-entries.test.mjs` 断言 client 源码包含 `attention` 与 `/answer`。

---

## 3. 停止键只停对话不停 run（P0）

**现状**

- 面板停止按钮只调 `POST /cancel`（`lib/client.js:969-977`）。
- `/cancel` 走 `host.cancelTurn(sessionId)`（`lib/console.js:1252-1256`），只中断当前 turn。
- run 级取消路由早就存在：`POST /runs/:id/cancel`（`lib/console.js:1415-1433`），控制台页在用（`public/console.html:2221`、`:2239`），面板从未调用。
- 任务行是 `div`，没有取消入口（`lib/client.js:739-745`）。

**用户可感知的后果**

点停止后界面看起来停了，但后台 run 还在跑、还在花 token、还在写文件；用户必须等它自己结束或去关掉整个应用。

**改造要点**

- 停止键语义改成「停这一轮 + 停这条 run」：先 `POST /cancel`，再对 `model.runs` 里 `status === 'running'` 的每条 run 调 `POST /runs/:id/cancel`；结果用 `canceling` 帧和 `runs` 帧回填。
- 任务行加 hover 可见的「停止」图标按钮，只取消该条 run。
- 取消失败（501/404）要显示原因，不静默。

**验收**

1. 起一个长 run，点停止：`/cancel` 与至少一条 `/runs/:id/cancel` 都返回 200；run 状态变 `cancelled/interrupted`，任务行变灰。
2. 单条任务行点停止，只影响该 run，其他 run 继续 `running`。
3. 宿主不支持 run 取消时，面板显示「这个宿主不能取消 run」，不假装成功。

---

## 4. 审批生命周期与默认权限（P1）

**现状**

- 最后一个 SSE 客户端断开时，所有待决审批立即 `settle('cancelled')`：`lib/console.js:871-883`，注释明确写「关页面或断流永不批准」。
- 审批默认 10 分钟超时（`lib/console.js:500-514`），但实际几乎走不到超时，因为面板一关就取消。
- 子会话审批策略被宿主钉为 `never`：`README.zh.md:207`。命令 worker 的默认 `danger-full-access` 在 `lib/index.js:449`、`lib/index.js:1555-1571` 有显式放行路径。
- 结果是：默认 profile 下要么根本不出审批卡，要么出了卡也因为切走而自动取消。

**用户可感知的后果**

审批 UI 是摆设：用户既看不到该看的请求，又会在切换会话/关闭面板时让正在等批准的工具调用直接失败。

**改造要点**

- 关闭/切走只 `detach()`，不再 `settle('cancelled')`；保留到 10 分钟超时，超时才取消。
- 待决审批进入未读通知；重新打开面板时从 `state.approvals` 恢复（现在已经恢复，但要保证没被提前清掉）。
- 默认权限给一个可用组合：桌面 profile 保持 `danger-full-access` 只用于命令 worker，其余工具走 `workspace-write` + `approval: on-request`；在 `cordis.patch.yml` 示例里写清。
- 面板里明确显示「本次会话已放行该工具」的作用域，避免用户以为全局生效。

**验收**

1. 制造一个待审批调用，关闭面板再打开：卡片仍在，未超时前可批准。
2. 超过 10 分钟未处理：自动 `cancelled`，界面显示「已超时」。
3. 默认 profile 起一个写工作区外文件的调用：出现审批卡（而不是静默失败或静默放行）。
4. `test/console.test.mjs` 增加「断开连接不取消、超时才取消」的用例。

---

## 5. 产物卡缺失（P1）

**现状**

- 服务端完整：`GET /api/console/artifact`（`lib/console.js:1112`），`serveArtifact()` 以 run 报告为白名单（`lib/console.js:898`），支持 `token` 查询参数。
- 控制台页有产物行、预览、在新标签打开、下载（`public/console.html:2302-2335`、`:2447-2468`）。
- 面板没有任何产物 UI：`lib/client.js` 全文不含 `artifact`。

**用户可感知的后果**

超级智能体说「报告写好了」，用户只能自己去文件管理器里翻；面板里看不到、点不开。

**改造要点**

- 任务行展开后列出 `run.report` 引用的产物（名称 + 大小），点击在主列内预览 Markdown/HTML/图片。
- 每个产物提供「在文件夹中显示」，复用宿主打开工作区路径的能力（`lib/index.js` 已有的 workspace 打开钩子），不要自己 `shell.openPath`。
- 下载走 `artifact?path=…&runId=…&token=…`，token 只在这一处拼进 URL。

**验收**

1. 完成一次 run 后，任务行展开 2 步内看到产物卡；点击 1 步预览。
2. 「在文件夹中显示」打开的是产物所在目录且选中文件。
3. 非报告白名单路径请求 `artifact` 返回 404（现有行为，补一条测试锁定）。
4. 预览 HTML 时 sandbox 属性存在（控制台页已有实现，面板复用同一 CSP/沙箱口径）。

---

## 6. 常驻工具与指导语的全局开销（P1）

**现状**

- 14 个工具，其中 8 个无任何 `when` 条件，对宿主每个会话常驻：
  `superagent_start`（`lib/index.js:2028`）、`status`（`2374`）、`list`（`2397`）、`help`（`2437`）、`cancel`（`2464`）、`resume`（`2492`）、`followup`（`2537`）、`answer`（`2609`）。
- 另外 6 个用 `EXTRA_TOOLS` 做了按会话展开门控（`lib/index.js:1307`，应用点 `2356/2607/2865/2968/3156/3215`）。
- 指导语在 `agent/pre-step` 第一步注入（`lib/index.js:1261-1291`），只对顶层会话生效（深度门控在 `1277`），但对**所有**顶层会话生效，包括与超级智能体无关的普通会话。
- 工具注册没有 `delegationDepth` 判断：8 个常驻工具在 worker 子会话里同样可见（搜索 `delegationDepth` 只有指导语一处）。
- 每次请求都要为这些声明付 token，且模型会误用 `superagent_*` 处理单步任务。

**用户可感知的后果**

普通会话的工具列表被挤占、上下文变贵；worker 可能反过来自己起 run，形成套娃调度。

**改造要点**

- 8 个常驻工具改为按会话激活：首次调用 `superagent_help` 或显式 `/superagent` 前缀才展开；或至少给 worker 加 `delegationDepth === 0` 条件。
- 指导语只在「用户显式进入超级智能体空间」时注入，不再对所有顶层会话注入；或降级为 `superagent_help` 的输出内容。
- 在 doctor 里增加一项：统计每次请求的常驻工具数，超过阈值告警。

**验收**

1. 新建一个普通宿主会话，工具列表里 `superagent_*` 数量为 0（或仅 `superagent_help`）。
2. 在超级智能体面板发一条消息后，工具列表恢复 8 个。
3. worker 会话的工具列表为 0 个 `superagent_*`。
4. doctor 输出包含 `resident tools: N`，并有阈值判断。

---

## 7. 两处实现问题（P1）

### 7.1 自建 cron 未接宿主 `ctx.schedule`

**现状**

- 插件自带 `lib/cron.js`（14 KB），调度循环是 `lib/schedule.js:344` 的 `setIntervalFn`，默认 30 秒 tick（`lib/index.js:1855`）。
- 全仓库没有任何 `ctx.schedule` 调用（检索 `ctx\.schedule` 无命中）。
- 宿主「自动化任务」页面因此看不到这些计划，重启后只能靠插件自己的 `schedules.json` 恢复（`lib/index.js:1820-1822`）。

**后果**

用户在宿主的定时任务列表里看不到自己创建的 plan；宿主停掉插件时计划静默消失；两套定时器可能重复触发。

**改造要点**

- 若宿主提供 `ctx.schedule`，把 plan 注册进去，插件只保留「到点后起 run」的执行器；没有该能力时再回退到本地 tick，并在 `superagent_schedule` 的返回里说明「本宿主不显示在自动化任务」。
- 迁移已有 `schedules.json`，保留 `id`，避免重复。

**验收**

1. 在有 `ctx.schedule` 的宿主上创建 plan，宿主「自动化任务」列表出现同名条目。
2. 删除 plan，宿主列表同步消失。
3. 无 `ctx.schedule` 的宿主仍能按 30 秒 tick 触发，且返回文案明确说明未注册到宿主。

### 7.2 守卫把 `node -e` 里的 `^` 当成盘符路径

**现状**

- 真实拦截事件：`C:\Users\18375\.dsh\state\superagent\audit\audit.jsonl`，`evt_6adc3bd7…`，时间 `2026-11-17T09:42:40.596Z`，`action: pwsh`，`rule: path/outside-allowlist`，`meta.reason: "C:\\^ is outside every allowed write root (…)"`。
- 机制：`writeTargetsOf()`（`lib/guard.js:357-404`）在原始 segment 上用正则扫 `>`/`>>`（`:363`），不识别引号边界；`node -e "…"` 里的比较符/箭头被当成重定向。捕获到的片段 `^` 交给 `resolveTarget()`（`:187-209`），非绝对路径按 cwd 解析（`:203`），cwd 是 `C:\` 时就得到 `C:\^`，再命中 `path/outside-allowlist`（`:291`）。
- `segmentsOf()`（`lib/guard.js:331-336`）只按换行、`&&`、`||`、`;`、`|` 切分，也不处理引号。

**后果**

合法的只读命令被拦截，用户看到莫名其妙的「C:\^ 不在允许目录」，只能换写法绕过，守卫可信度下降。

**改造要点**

- 先按引号切分 segment，引号内的 `>`、`^`、`=>`、`>>` 一律不参与写目标识别。
- `node -e` / `python -c` / `pwsh -Command` 这类内联脚本整体视为「不透明参数」，除非同时出现真实重定向（引号外 `>`）。
- `resolveTarget` 对单字符标点（`^`、`&`、`=`）直接返回 `null`，不要按 cwd 解析。
- 用这次的真实命令补一条回归用例。

**验收**

1. audit 里那条 `node -e` 命令重放为 `allowed`，不再产生 `path/outside-allowlist`。
2. `node -e "console.log(1 > 0)"`、`node -e "const f = x => x + 1"`、`node -e "const r = /^a/.test('a')"` 三条全部放行。
3. 真正的 `echo x > C:\Windows\Temp\a.txt` 仍被拦截。
4. `test/guard.test.mjs` 新增上述 4 条用例，全绿。

---

## 阶段计划（按依赖排序）

| 阶段 | 内容 | 依赖 | 完成标志（可验收） | 发版 |
|---|---|---|---|---|
| S0 | 本文件 | 无 | 文件进仓库，7 条都有证据与验收 | 随下一版 |
| S1 | 面板入口：会话新建/切换/历史、上传、产物预览、待决策一次解锁 | S0 | 面板 2 步内完成新建/切换/上传；产物与问答卡可见；`test/client-entries.test.mjs` 通过 | 0.17.0 |
| S2 | 待决策问答卡 + 计划确认 + 未读计数 | S1 | 提问式 prompt 5 秒内出卡，回答后 run 恢复 | 0.17.x |
| S3 | run 级停止 | S1 | 停止键同时取消 turn 与 run；任务行可单独取消 | 0.17.x |
| S4 | 审批生命周期 + 默认权限 | S1 | 关面板不取消；超时才取消；默认 profile 出审批卡 | 0.17.x |
| S5 | 产物卡完整化（预览/在文件夹显示/下载） | S1 | 三步内打开任何报告产物 | 0.17.x |
| S6 | 常驻工具与指导语门控 | S0 | 普通会话 0 个 `superagent_*`；worker 0 个 | 0.18.0 |
| S7 | cron 接 `ctx.schedule` + 守卫修复 | S0 | 宿主自动化列表可见；4 条守卫回归全绿 | 0.18.x |

每阶段收尾口径固定：`pnpm test` 全量、`node bin/… doctor` 全绿、`npm publish`、更新 profile 依赖与 `minimumReleaseAgeExclude`、`pnpm install`、回写 `plugin-index.json`。不重启 DSH/Electron。
