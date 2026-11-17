# Changelog

Doc-only releases: npm serves the README from the tarball, so a README edit is
invisible on the package page until something is published. When the edit
changes what a reader would do — install commands, limits, troubleshooting
steps — it gets its own patch version (0.9.2, 0.9.3). Typos and wording ride
along with the next code release. A doc-only version leaves `lib/` and `bin/`
byte-identical to the version before it, and the pinned install line in the
README is updated to the version being released.

## 0.16.8 — 2026-11-17

### 变化

- **去掉输入区的「排队 / 插话」选择。** 用户不再需要决定投递方式：空闲时发送
  正常开启一轮，回合进行中发送自动使用 `steer` 立即交给超级智能体，适合连续
  快速发多条消息；对应 `mode` 状态、`Menu` 选择器和 chip 样式一并删除。
- 输入区只剩附件与发送/停止两个控件；附件按钮从「+」换成宿主回形针图标，
  不再看起来像新建会话，提示文案保持「放进工作区」。

## 0.16.7 — 2026-11-17

### 变化

- **头栏只留边栏开合按钮。** 去掉「刷新」按钮和「已连接 / 流中断 / 连接中」
  状态文字，清理对应的 `refresh` 动作、`conn` 状态与状态点样式；重连仍由
  面板自动进行，初次加载失败时保留原有的错误页与「重试」。

## 0.16.6 — 2026-11-17

### 变化

- **删掉头栏的「新建会话」。** 单会话模型下它没有意义；`new-session` 动作、
  新建图标一并移除。头栏只剩「刷新」和边栏开合两个按钮。
- **清掉前端最后的会话列表逻辑。** 删除 `/sessions` 拉取、`sessions` /
  `sessionsReason` 状态和 `runs` 帧触发的列表刷新，前端不再有任何多会话
  展示或切换路径；当前 `sessionId` 只用于发消息和取消回合。
- 右栏仍然只展示超级智能体调度的会话（目标 + 状态 + 运行中数量）。

## 0.16.5 — 2026-11-17

### 变化

- **不再显示会话列表。** 用户只和超级智能体对话，右栏只展示它调度出去的会话
  （任务线：目标 + 运行状态），不再提供普通会话式的历史会话切换；`switch`
  动作一并删除。
- **边栏开合按宿主普通会话的行为重做。** 右栏改为网格轨道 + 位移的组合动画
  （与宿主 `AppFrame` / `SidebarRight` 同一套 slow/ease-in-out 节奏），收起时
  轨道归零、面板滑出；展开时轨道占 360px，正文重新居中而不是被贴边压窄。
  头栏按钮在展开/收起时镜像图标（宿主 `collapseGlyph` 的做法），保留运行中
  数量徽标。
- **窄窗口（≤960px）改为浮层抽屉。** 轨道保持 0，不挤压正文，面板带
  `shadow lv2` 浮在右侧。
- 正文列宽优先使用宿主 `--dsh-chat-content-width`，缺失时才退回
  `clamp(680px, 会话列宽 * .64, 920px)`，不再拿 `--dsh-chat-user-width`
  二次相乘。
- 输入区状态行去掉会话 id，只保留调度会话数量。

## 0.16.4 — 2026-11-17

### 变化

- **默认布局回到单列。** 打开时只有正文，没有常驻右栏；会话/任务线列表默认
  收起，和普通会话一致。
- **右栏改成可展开的抽屉。** 头栏放宿主 `IconPanelLeft` 图标按钮展开/收起，
  快捷键 `Ctrl/Cmd+Shift+B`，`Esc` 关闭；状态存 `localStorage`
  （`dsh-superagent.rail-open`），下次打开保持上次选择。
- **展开不挤压正文。** 抽屉用绝对定位浮在正文右侧（`z-index` 30、
  `shadow lv2`、最大宽度 `min(84vw, 320px)`），正文列宽仍按宿主
  `--dsh-chat-user-width` 公式计算，窄窗口下也是浮层而不是横向挤压。
- **收起时保留最小信息。** 按钮上显示运行中任务线的数字徽标（超过 9 显示
  `9+`），不再为了状态保留一整列。
- **头栏标题固定为「超级智能体」。** 去掉自动生成的会话名和面包屑分隔斜杠；
  会话名仍保留在数据层与抽屉列表里，不再当页面标题展示。

## 0.16.3 — 2026-11-17

### 修复

- **assistant 正文恢复了 Markdown 渲染。** 根因不是渲染分支，而是组件探测：
  `MarkdownText` 是 `React.memo` 包装的对象，`Button` 是 `React.forwardRef`
  对象，0.16.1 起用 `typeof x === 'function'` 判断，两者都被误判为「宿主没导出」，
  于是正文一直走 `.dsa-md-plain` 纯文本兜底（表格、加粗、行内代码原样露出）。
  现在同时接受 function、`react.memo` 和 `react.forward_ref`，流式与完成态的
  正文都走宿主 `MarkdownText`。
- **降级不再静默。** 缺少宿主组件时在控制台打印一次缺失清单；单条消息降级为
  纯文本时打印带消息 id 的 `console.error`；`MarkdownText` 运行期抛错由错误
  边界接住并记录，正文继续以纯文本显示。

### 已知待办（本轮未改）

- 委派提示词里把 Run ID、token 统计、并行上限这类内部信息写进了面向用户的
  输出，措辞需要单独调整。

## 0.16.2 — 2026-11-17

### 变化

- **「排队 / 插话」不再用浏览器原生 `<select>`。** 换成宿主导出的 `Menu`：
  深浅两套语义 token、32px 行高、圆角与阴影都来自宿主菜单，选中态有对勾，
  支持方向键 / Home / End / Enter、Esc 关闭、点击外部关闭、关闭后焦点回到
  触发器，并用 `portal` + CSS anchor 定位，不会被输入卡裁掉。
- **原生提示条换成宿主 `Tooltip`。** 刷新、新建会话、附件、发送、停止、会话行、
  任务线行、工具参数气泡都改用宿主 `Tooltip`（无 primitives 的宿主才退回
  `title`），不再出现系统黄框提示。
- 附件仍用隐藏的 `<input type="file">` 触发系统文件选择器——宿主没有文件选择
  组件，这个输入框本身不可见，外观由旁边的宿主风格按钮承担。

## 0.16.1 — 2026-11-17

### 变化

- **运行中能停下来了。** 发送键在回合运行时变成宿主同款的 34px 圆形停止键
  （中间 10px 圆角方块），点击后进入取消中并画转圈；后端补了真正的回合级取消：
  新增 `POST /api/console/cancel`，走宿主的 `sessionController.cancel({ sessionId })`，
  成功广播 `canceling` 帧，回合结束后自动复位。宿主没有取消能力时明确返回 501，
  不会只画一个按钮。
- **用户气泡换成宿主的 `UserMessageBubble`。** 圆角 `radius-xl` 20、内边距
  `10px 16px`、行高 `calc(22px + delta)`、字号跟 `--dsh-content-font-size`，浅色下
  是宿主的 `deepseek-50` 浅蓝，不再是自造的灰色。
- **正文列宽按宿主公式。** 正文列改为
  `clamp(680px, var(--dsh-chat-user-width) * .64, 920px)`，滚动区左右各留 32px；
  审批卡和 toast 跟随同一列宽，不再贴边。
- **Markdown 改用宿主的 `MarkdownText`。** 自造的渲染子集整段删除，表格、引用、
  分割线、嵌套列表、斜体、围栏语言标记和代码高亮全部由宿主组件负责，标题字号
  走 `--dsw-font-markdown-*`。
- **审批卡对齐宿主。** 外框 `radius-xl` 20、`border warn-secondary`、
  `bg input-major`、`shadow lv2`；顶部加 `warn-tertiary` 警示条（`StateDot`
  warning + 「等待你的批准」）。按钮顺序改为 拒绝 → 允许一次 → 本会话都放行
  （primary）；请求期间 `disabled` + `aria-busy`，失败会弹出可见提示，不再
  吞异常。
- 修掉拼错的 token：`--dsw-alias-state-warning-primary` → 宿主真实存在的
  `--dsw-alias-state-warn-primary`。

## 0.16.0 — 2026-11-17

### 变化

- **主面板不再套 iframe，改成宿主自己的界面。** 插件 client 直接
  `require('@deepseek-ai/dsh-client-ui-primitives')`，用宿主的 `Button`、
  `FishLogo` 和整套 `Icon*` 图标在 `main` 槽位里原生渲染；组件活在宿主的 React
  树里，主题、字体、图标、深浅色切换全部天然一致，原先手写的 iframe 主题跟随
  代码整段删掉。
- **骨架按宿主的实测尺寸重搭**：顶部栏 76px / `10 28 0 20`、面包屑 14/20 圆角
  12、空状态 `26/32 500` + 鱼标、输入卡圆角 28、输入区 `4 8 0 14`（停靠 36 /
  欢迎页 52）、工具栏 `2 8 6` 间距 12、发送键 34 圆、统计行 22、会话行 32 高
  圆角 12、行尾时间 10/16。数值来自宿主 asar 内的 `*.module.css`，不是目测。
- **自造的品牌头、大圆角空状态、三个胶囊全部去掉**，换成宿主标题栏 +
  欢迎页 + 输入卡的形态；右栏会话改成宿主的 32px 列表行。
- **新增同源中继** `/superagent/api`（node 侧挂到宿主 web server 的前缀路由）：
  面板用相对路径调用控制台，令牌仍只留在服务端，浏览器不接触明文；事件流按流式
  转发，不缓冲。
- 附件按钮接回真实上传（`/upload`），路径写进输入框。

## 0.15.4 — 2026-11-17

### 变化

- 报告弹窗里的链接改用宿主的强调色，不再退回浏览器默认蓝。

## 0.15.3 — 2026-11-17

### 变化

- **控制台改成宿主自己的样子。** 配色不再自备一套，直接从 DSH 的主题定义里取：
  底色、层级、边框、三级文字、强调色全部对齐宿主，绿色不再当主色；深色与浅色
  两套都是宿主真实的色值，不是把一套反相凑出来。
- **跟着宿主换主题。** 控制台不再自带主题开关：打开时按宿主当前主题渲染，宿主
  切换外观后即时跟随，不用刷新页面。
- **控件对齐宿主。** 主/次/图标/危险按钮、输入框、分段选择、标签、分隔线、滚动条、
  焦点环、提示条、空状态都按宿主的尺寸与状态统一：32px 高、8px 圆角、13px/500，
  hover 与 active 用宿主交互色，焦点环 2px 用宿主业务色。
- **提示与出错面板**改用宿主 token（文字层级、描边、悬停底色），不再自带一套圆药丸。

## 0.15.2 — 2026-11-17

### 变化

- **桌面端点开「超级智能体」不再白屏。** 控制台页面原先只允许本地 http 页面把它嵌进
  主面板，而桌面端的界面跑在自己的 `dsh-app://` 地址上，浏览器按页面声明的安全策略
  拒绝渲染，右侧就只剩一片白。现在页面按「谁在嵌入我」放行：本地回环地址照旧，桌面端
  这种非 http(s) 的自定义地址由界面把自己的地址告诉页面，以后换 scheme 也不用再改
  插件。网络上的站点仍然嵌不进来，token 仍是唯一入口。

## 0.15.1 — 2026-11-16

### 变化

- **调度板挪到右侧，收得起来。** 会话调度从对话正文里搬出来，成了右侧常驻栏，点栏
  上箭头收起、再点展开。收起状态记在浏览器里，刷新或重开页面还是你上次选的样子；窄
  到 720px 时默认收起，展开是浮在对话上方，不会把正文挤成一条缝。
- **一个会话一张方卡。** 卡片按网格排列，一张卡就是一个会话：上面写这个会话现在是
  在跑、排队、等你决定、等审批，还是完成、失败、空闲；下面直接写跑了几条任务线、
  并行几路、有没有排队，以及现在在跑什么工具。点卡片进入详情，能看到这个会话里的
  每条任务线、每个步骤的状态、耗时，以及哪一步在等哪一步。数据仍只读宿主的会话列表
  和现有 run 记录，没有另造状态或第二套队列。

## 0.15.0 — 2026-11-16

### 变化

- **界面上的字改成人话。** 空状态、按钮、提醒、审批卡、报错和向导都按你当下要做的事
  写一句话：具体名词代替抽象名词，不用「一键」「赋能」这类词，不排比，不客套，也不堆
  感叹号。文案分两处：页面里的固定句子在 `public/console.html`，服务端回给你的错误说明
  在 `lib/console.js`；状态词、耗时、提醒标题这些跟着 run 记录自动生成。
- **调度板：一眼看到几条线在跑。** 有任务在跑时，对话上方出现一块调度板：每一步一条
  时间条，按真实的开始、结束时间画；板头写清同时跑几条任务线、并行几步、几步在等前
  一步、几条在排队，每行的任务线标题旁是状态和耗时。数据全部读现有 run 记录（含
  `subtasks` 的 `startedAt`/`finishedAt`/`waitingOn` 和 `limits.maxParallel`、
  `queue.position`），没有第二套状态。窗口窄到 720px 时每一步改成上下两行，时间条
  占满宽度，不会挤在一起。

## 0.14.9 — 2026-11-16

### 变化

- **文件可以直接拖进输入框，也能粘贴进来。** 拖到输入框或按 Ctrl+V 粘贴的图片、文档会
  复制到当前对话的工作区，路径自动写进消息，我拿到就能读。单个文件 8MB 以内，只收
  图片、PDF、Markdown/文本、CSV/JSON、Office 文档、压缩包和代码文件；类型或大小不
  合适时直接告诉你「不能放什么、可以放什么」，不会静默失败。文件只会落在当前对话的
  工作区里，不会写到别处，也不会覆盖上一次放的同名文件。
- **关掉页面也知道发生了什么。** 任务跑完、没走通、或者在等你批准时，页面会亮起提醒：
  标题变成「(1) Superagent 专属空间」这样的未读计数，右上角出现「提醒」入口。重新
  打开页面还能看到当时的结果——「跑完了」「没走通」「要你批准」都还在，点一条就能跳到
  对应的任务线；已经看过的提醒不会重复打扰。任务结束时的通知仍然走插件原来的通道，
  所以即使页面一直关着，回到对话里也能看到完成或需要决定的说明。

## 0.14.8 — 2026-11-16

### 变化

- **停止是真的停止。** 以前点「停止」只是请求，卡片转圈到宿主自己结束；现在会向宿主
  发起取消，并显示「停止中」，等宿主确认后才变成「已停止」。
- **历史改读宿主的会话列表。** 能看到宿主上实际有哪些对话（消息条数、产物数、最后
  更新时间），并且可以切回之前的对话继续。
- **任务线卡显示耗时和当前工具。** 每一段跑着的步骤都有实时计时，并显示它此刻在用
  哪个工具，不用等结束才知道卡在哪。
- **产物就地预览。** 点开产物直接在页面里看，不再跳新标签页；网页类产物也在框内打开。
- **审批卡说清要写什么、什么时候过期。** 卡片显示即将写入的内容和路径、剩余时间倒计时，
  并多一个「本会话内允许」：同一个工具在这个对话里不再逐次打扰，换对话后恢复询问。
- **消息可以复制、编辑后重发。** 复制按钮一键拿走原文；编辑会把原话放回输入框，改完
  重新发送，不用手打一遍。

## 0.14.7 — 2026-11-16

### 变化

- **长期目标只问该问的。**
  - 宿主重启后原 run 无法恢复时，不再立刻弹决策：尝试次数还够就自动换一次新尝试
    （已完成阶段不会重跑），用尽后才问。
  - 等待决策不再冻结整个目标。其他正在跑的阶段继续被记录，第二个阶段的问题会和
    第一个一起列出，一次看完；等待期间不派发新阶段。
  - 没有任何下游阶段依赖的阶段，两次失败后自动跳过，目标以 `partial` 收尾。状态
    与完成通知会点名是哪一段、失败原因，并给出单独重来的命令（`superagent_goal
    action=retry_phase goal_id=… phase_id=…`），不静默跳过。有下游依赖的阶段仍然
    停下来问人。

## 0.14.6 — 2026-11-16

### 修复

- **配了控制台端口后插件不再整个不加载。** 审批桥在真实宿主上读取 `ctx.root`
  会抛错，导致插件启动时只留下 `1 entry did not activate`。改为用 Cordis 的根
  上下文符号取根，取不到就回退到插件自己的上下文。
- **关闭页面或断线后，挂起的审批立即取消。** 以前最后一个控制台页面关闭、SSE
  流断开后，工具调用仍会停在那里等满 10 分钟才按超时处理；现在最后一个客户端
  断开就结算为 `cancelled`，既不自动批准，也不再占着会话。
- **启动期停止不再报时间线 ENOENT。** 状态目录还没建好时刷新时间线会写失败；
  现在先建目录再写临时文件。

### 文档

- 首屏改成真实界面截图（任务线卡、汇总与产物、审批卡、侧边栏入口）加三步快速
  开始，并补了三条常见问题；中文默认，英文同步。

## 0.14.5 — 2026-11-16

这次只做一件事：把插件自己占的地方变小，能力一个不少。

### 变化

- **常驻开销降了 77%。** 每次请求都会带上插件的工具说明和一句引导语，这部分
  从约 4,923 token 降到约 1,139 token（同一宿主、同一模型实测）。工具描述不再
  写长篇使用手册，只留"什么时候该用它"；详细说明放到工具真正被调用时返回。
- **常用工具直接可见，冷门能力按需展开。** 默认只声明 8 个常用工具：起 run、
  查状态、列表、取消、恢复、追加指令、回答提问，以及 `superagent_help`。长期
  目标、定时任务、实时插话、跨 run 笔记、模板、审计这 6 个不常用工具不会一
  直占着上下文；需要时先调一次 `superagent_help`，它们在下一步自动出现在工具
  列表里，会话按需记住这个状态。
- **引导语每个会话只出现一次。** 以前每个 turn 都会再塞一份，长会话里越来越
  占地方；现在只在会话开始时注入一次，内容也缩短了。

### 对使用者的影响

- 工具名、参数、行为都没有变；已经在用的工作流照常跑。
- 需要定时任务、长期目标这类能力时，模型会自己先调 `superagent_help`，不需要
  你额外提示；展开后用法与之前一致。
- 新增回归测试钉住"一次请求固定带上的工具定义 + 引导语"的上限，超了测试就
  失败，避免以后又把开销涨回去。

## 0.14.4 — 2026-11-16

This release gives a goal a life longer than one run, and fixes a check that
could not see a file that was already on disk.

### Added

- **Long-term goals.** `superagent_goal` takes one goal and splits it into
  ordered phases; each phase is still an ordinary run, so planning, parallel
  subtasks, budgets, attention items, reports and resume keep working the way
  they already did. Phases run in dependency order, retry within a budget, and
  survive a host restart: a phase already finished is not planned again, and a
  goal picks up from where the disk says it stopped. When a phase runs out of
  budget, keeps failing without progress, or its worker and the machine check
  disagree about the result, the goal stops and asks the person to decide —
  `superagent_status` shows both sides of the evidence and the options (accept,
  retry, stop) instead of guessing. The design is in `docs/LONG-GOAL.md`, now
  shipped with the package.
- The plugin mounts thirteen tools; the new one is listed in the README.

### Fixed

- **A deliverable that is on disk is no longer reported as missing.** In goal
  mode the deliverable check resolved declared paths against the directory the
  host was launched from, while the worker wrote into the goal's workspace. The
  file existed, the check looked elsewhere, and the subtask failed with
  `declared deliverable missing` — then retried with a fresh worker until the
  attempts ran out. The check now uses the same base directory as the goal's
  own acceptance step. Relative and absolute declarations, either separator,
  and a different case on Windows all name the same file, and an absolute path
  outside the workspace is still refused. A write that becomes visible only
  just after the check starts is re-read inside a bounded 150 ms window; a file
  that is never written still fails as missing.

## 0.14.3 — 2026-11-15

The release is about the three things a run could not answer for itself: which
directory it is allowed to work in, whether its files actually reached that
directory, and whether the session mounts the plugin at all.

### Added

- **Sidebar entry and approval card.** The package now publishes
  `exports["./client"]` → `lib/client.js` and declares `dsh.client.platform:
  "web"`, so a web host shows a Superagent entry next to its own sidebar items
  instead of leaving the console reachable only by port. The entry discovers the
  console through `GET /superagent/console-address` (the route answers with the
  address the host actually serves, not the port from the patch file), and
  `approval/request` is bridged to the console session with `prepend` so the
  approval card appears where the console is open and an unanswered request
  counts as a refusal. A client bundle that does not compile is reported on the
  entry itself (`client.js.broken`) instead of silently disappearing from the
  sidebar.
- **First-use wizard.** `lib/wizard.js` plus `GET|POST /api/console/wizard/*`
  (`status`, `preview`, `save`, `rollback`, `trial`) walk a user who has never
  opened a terminal from "nothing configured" to "a real run finished": the
  environment check explains each item, an API key is verified against the real
  endpoint before anything is written, and the key itself goes to the host's
  credential store with only its reference left in the profile patch. The patch
  editor understands exactly the two entries it owns (`llm-pi-ai`,
  `agent-default-model`), leaves every other line and comment untouched, and
  keeps the last 10 backups restorable from the page. The last step is a real
  trial run in a temporary directory, not a simulated success. Without the
  wizard hooks on the host the console answers `501 wizard-unavailable` and says
  why instead of drawing a dead form.
- **Task board.** `boardPort` serves one Chinese page where a run is a column
  of subtask cards (status, steps, elapsed time, tokens, cost, dependencies,
  and the dependency that skipped it). Cards can be cancelled or rerun one at a
  time: `cancelSubtask` aborts only that child and the rest of the run
  continues; `rerunSubtask` resets that subtask and any dependents skipped only
  because of it, then resumes without touching completed siblings. A run whose
  remaining work was all cancelled now ends as `cancelled`.
- **Human inbox.** Planner `needsInput`, deliverable reviews, missing
  capabilities, policy confirmations, browser checks that need a person, and
  interrupted runs are collected in one list with what happened, why a person
  is needed, the options, and the effect of answering. Answers use the same
  `orchestrator.answer` path as `superagent_answer`, with the run owner as the
  actor and an audit line naming the answer. An empty inbox says so.
- **Plain-language failures.** `lib/board-messages.js` maps capability blocks,
  unusable plans, missing deliverables, sandbox writes, `spawn EPERM`,
  unavailable models, budget/deadline exhaustion, and a dead scheduler owner to
  one Chinese sentence plus one action; the raw error is folded away.
- **Template forms.** The four built-in templates show their purpose,
  parameters, and expected subtask count; submitting starts a run from the
  board's own persisted Host Session and jumps to its board.
- **Reconnect-safe stream.** `/api/board/events` opens with a full snapshot and
  polls durable run records, so a refresh or a dropped connection restores the
  board instead of leaving it blank.
- **A stated policy for multi-step goals.** A session that mounts
  `superagent_start` next to the host's `subagent` tool can hand-orchestrate the
  work with the latter and never create a run — no plan, no timing, no merged
  report, nothing in the run list. `lib/index.js` now registers an
  `agent/pre-step` hook that prepends one system-reminder at the first step of a
  **top-level** turn only (`delegationDepth === 0` and no `origin: "subagent"`),
  never twice in the same turn, and passes a rejected step through untouched.
  The text defines multi-step (two or more independently deliverable artifacts,
  or a prerequisite step), names `superagent_start(mode="planned")` /
  `superagent_followup` / `superagent_status`, says to call the tool first rather
  than audit its own tool list, and keeps single actions (one lookup, one edit,
  one command, one short piece of writing) out of a run. Guidance only: no new
  tool, no new spend. `superagent_start`'s description says the same in one
  sentence.
- **`workspaceBase`.** New config (`session` by default, `config` for the old
  behaviour) decides what per-worker isolation is based on. See “Changed” for
  what it fixes; the README table documents both values.
- **The planner preset has a card of its own.** `cordis.patch.yml` now declares
  the tool-less `planner` preset with the Chinese name
  “插件内部：规划器（请勿选择）”, a description saying that picking it leaves the
  session with no tools, and `order: 9999`. A fresh install used to show a bare
  `planner` row with an empty description at the top of the mode picker. The
  host preset schema has no hidden/internal field, so this is the closest the
  schema allows.

### Changed

- **Four workers per layer by default.** `maxParallel` now defaults to 4 (hard
  max 8) instead of 3, so a plan whose layer has three independent subtasks
  starts all three instead of queueing the third. Dependency order is unchanged —
  a subtask still starts only after its `dependsOn` finish — and two subtasks
  that declare the same deliverable path are never in flight together, so a wider
  layer cannot turn a same-file race into a lost file.
- **A budget stop is a notice, not an error.** Hitting `maxModelCallsPerRun` or
  `maxTokensPerRun` no longer writes `model-call budget reached (86/80 calls)`
  into the run's `error`. It is recorded as `budgetStop` (detail, time, calls,
  tokens), the status text prints it as `note: stopped starting new workers — …`,
  and a run that still finished every subtask stays `completed` with `error`
  null. A run that did not finish keeps the detail in `error` so the reason is
  not lost, and the scheduler still pauses a plan on it.
- **A run whose files never reached the target is `partial`, not `completed`.**
  A skipped merge (uncommitted changes in the main checkout) and a conflict both
  leave the worker's work only inside its branch. Such a run now drops to
  `partial` and records one attention item naming: the branches, the worktree
  each is kept in, why the merge was refused, the two options, and the exact
  `git stash push -u` plus `git merge --no-ff <branch>` commands that finish it
  by hand. Nothing is deleted, so a manual merge stays possible.
- **The package entry point is `lib/entry.js`.** `main` and `exports["."]` point
  at a file whose only job is to import `lib/index.js`; a missing sibling
  (`wizard.js`, `board.js`, …) is caught there and reported as the missing file
  plus the fix (`Copy-Item lib\* -Force`, or reinstall) instead of the plugin
  vanishing with no explanation.
- **`superagent_status` reports a version mismatch.** When `package.json` on
  disk differs from the version the host loaded, the status text ends with
  `note: ... restart DSH`. Code is read once at startup, so replacing files
  changes nothing until a restart; the README's install section now says so.
- **Child activations carry the delegation fields twice.** `startActivation` is
  given both `request` and the same fields at the top level of the spec, because
  dsh 0.2.2-rc.1 reads the former and the desktop host (0.2.2-rc.3) reads the
  latter and otherwise throws `Cannot read properties of undefined (reading
  'id')` before any child exists.
- **The planner failure log keeps the host stack.** A planner attempt that fails
  inside the host now logs the stack alongside the message that goes into the
  run file.
- **Docs.** `README.md` / `README.en.md` / `README.zh.md` gained the restart
  requirement and the `workspaceBase` row; `docs/DETAIL.md` and
  `docs/DETAIL.zh.md` open “What it solves” with the dispatch-desk case (work
  spread across domains costs more to manage than to do). `docs/host-compat.md`
  lists every rc.1/rc.3 shape difference the plugin papers over — start-request
  field placement, child handle, host service probes, preset schema — with the
  file and line to re-check when the host changes.

### Fixed

- **Isolation followed `workspaceRoot` even when it named another project.**
  The base was taken from the profile, while the sandbox boundary, the declared
  deliverables, and the merge target all came from the session — so merges
  landed where nobody looked, or were refused because that checkout had
  unrelated local edits. The default (`workspaceBase: "session"`) now uses the
  session's cwd (or the repository root git resolves from it) and honours
  `workspaceRoot` only when it names that same directory, comparing paths
  case-insensitively on Windows. A mismatch is recorded on the run as
  `workspace.baseNote` and printed by status as `workspace warning: ...` instead
  of being silently applied; when isolation is impossible, the shared directory
  reported as `base` is the session's too.
- **A merge that never happened used to print `completed`.** The user opened the
  target directory and found it empty. Covered by the `partial` change above.
- **An incomplete install no longer looks like a plugin with no tools.**
  Covered by the entry-point change above.

## 0.14.2 — 2026-11-15

### Fixed

- **The detail page carries the language switch.** `docs/DETAIL.zh.md` and
  `docs/DETAIL.md` now open with `中文 | English`, pointing at the other
  document on GitHub. The plugin detail page previously rendered a Chinese body
  with no way to reach the English one, even though both READMEs had the switch.

## 0.14.1 — 2026-11-15

### Added

- **Plugin card metadata.** `icon.svg` is declared by the package manifest and
  exported as `./icon`; `locale/en.json` and `locale/zh.json` carry the title,
  description, and a `meta.detail` document. In a Chinese UI the card reads
  “超级智能体” with a Chinese one-line description, and the detail page renders
  `docs/DETAIL.zh.md` instead of the English README.
- **A format-1 plugin index** at `plugin-index.json`, with the package name, a
  Chinese title, and a `git` source pinned to a full 40-hex commit, so the
  Discover page can add the index and install or update the plugin in one step.
  The public URL and the two-step instructions are in the README.

### Changed

- `README.md` is now Simplified Chinese-first; `README.en.md` keeps the English
  text and both open with a language switch. `README.zh.md` mirrors the Chinese
  page, and `package.json`'s `description` is Chinese.

## 0.14.0 — 2026-11-15

### Added

- **Attach mode is complete.** With `runtime.browser.attachPort` set, every
  browser tool — listing, clicking, typing, screenshots, scripts — runs on the
  browser the user started with `--remote-debugging-port`, on the tab that is
  already open. The tab keeps its own window size (no viewport override), and
  `browser_close` detaches instead of terminating the user's browser (a blank tab
  created only because no page existed is closed). A port that is not listening
  now fails with the port, a Chrome/Edge start command, and an explicit
  statement that no profile was launched in its place; attach never falls back
  to a fresh profile.
- **Persistent profile option.** `runtime.browser.userDataDir` points a launched
  browser at one dedicated profile, so a sign-in done once is reused on later
  runs. The default is still a fresh temporary profile, which cannot see the
  user's daily cookies; the README spells out the trade-off and ignores
  `userDataDir` while `attachPort` is set.
- **Human checks hand back instead of failing.** `lib/browser.js` classifies
  page text for a sign-in wall, CAPTCHA / "confirm you are human", SMS or
  one-time code, two-factor, and QR login. `browser_open`, `browser_click`, and a
  submitting `browser_type` stop at such a page and return `[attention]` with
  the page, the check, where the person finishes it, and the next call — never a
  failure. New `browser_await_human` polls until the check is gone and reports
  ok, or hands back again at its timeout. It never solves, types, or scans the
  check. A headless launch explains that it has no window and points at
  `headless: false` or attach.
- **Audit distinguishes the connection.** Every browser audit line carries
  `meta.session: "attach" | "launch"`, plus `meta.port` and the reused tab for
  attach, or `meta.profile` / `meta.persistentProfile` / `meta.headless` for a
  launch. Human hand-offs are recorded as `kind: "attention"`,
  `decision: "attention"`, `result: "needs-human"`; attach failures record
  `rule: "runtime/attach-failed"` with the actionable message rather than being
  mistaken for a provider error.

### Changed

- The domain allow-list, irreversible-action confirmation, file-upload refusal,
  stop switch, and worker-tool guard all sit in the same call path as before, so
  they apply unchanged on an attach connection; tests cover each one there.
- `browser_type` masks the read-back value for a password field.

### Fixed

- **Costs are grouped by currency.** A run that used a USD-priced route and a
  CNY-priced route used to add their micro-units and label the sum with the
  first model's currency. It now keeps one subtotal per currency and prints
  them separately (`¥0.0952 + $0.0248`) in the run line, `superagent_list`'s
  ledger line, the `watch` footer, the exported `README.md`, and the HTML
  report; a mixed window gets one cost curve per currency. Single-currency runs
  keep the existing `¥0.3600` format, and an unpriced model stays `unpriced`
  rather than becoming zero.

## 0.13.0 — 2026-11-15

### Added

- **Goal mode.** `superagent_start` accepts `goal_mode: true` with an
  `acceptance` list, and the run no longer ends when its subtasks do. Each
  condition is `{id?, text, check?}`; a `command` or `file` check is executed by
  the plugin, so that verdict rests on a real exit code or a real file, and only
  an unchecked condition goes to an independent acceptance model. A failed round
  starts another with what is still missing, bounded by `max_rounds` (5),
  `max_wall_clock_minutes` (60), and `no_progress_rounds` (2), and stops with a
  written reason on the round cap, the wall clock, the deadline, a budget stop,
  an open attention item, or two identical failing rounds. One notification when
  the loop ends, none between rounds. `lib/goal.js`; off unless asked for, and it
  adds no tool.
- **Scheduled runs.** New `superagent_schedule` tool (`create`, `list`, `pause`,
  `resume`, `delete`, `run-now`) stores a plan — goal or expanded template, cron
  or fixed interval, time zone, its own budget and concurrency policy — and
  starts runs with nobody calling `superagent_start`. `lib/cron.js` is a
  zero-dependency 5-field parser (`*`, `*/n`, ranges, lists, month and weekday
  names, 0 or 7 for Sunday; seconds, `@`-macros, `L`, `W`, `#`, and `?` are
  refused by field). Missed windows are not replayed: `latest` runs the newest
  one and records the rest as missed, `none` skips them. A plan never overlaps
  itself, one slot stays reserved for manual runs by default, and three
  consecutive failures pause the plan and say so once. Plans survive a host
  restart, and an install with no plans behaves exactly as before.
- **Plan honesty and capability preflight.** The planner now returns
  `ambiguities` (phrases it cannot map to a concrete object), `needsInput`
  (questions only the user can answer), per-subtask `assumptions`, and
  `requires` capability tags. A plan that only raises questions stops the run as
  one decision point instead of guessing; assumptions are stored on the subtask
  and printed in status and the report. `preflightCapabilities` compares
  `requires` with the tools the session actually has before a worker starts: a
  missing capability blocks that subtask with the capability and the fix named,
  cascades `skipped` to everything downstream, and is never counted as success.
  When the host cannot list its tools the preflight records `unavailable` and
  blocks nothing.
- **User profile.** Optional cross-task memory (`memoryUserProfile: true`) in
  `lib/user-memory.js`: three categories (`fact`, `preference`, `decision`) in
  three files, a decision stored only with its reason, `superagent_memory` with
  `layer: "user"` reading and writing it, and forgetting as a real deletion
  under a lock with no tombstone. Everything is redacted before it is written,
  and nothing is constructed unless the operator turns it on.
- **Conversation console.** `lib/console.js` and `public/console.html` serve a
  loopback page (`consolePort`) that talks to a real Host Session through
  `sessionController` — create, prompt, follow, observe state — so a conversation
  can be started, followed up, watched while its derived run works, and have its
  attention questions answered from the page. Server-sent events stream updates;
  the one-time token is written to `<stateDir>/console.json`. Without
  `sessionController` the page says it is unavailable instead of drawing a
  fake conversation.
- **Runtime control: a real browser and, on Windows, the real desktop.** New
  opt-in layer (`lib/browser.js`, `lib/desktop.js`, `lib/runtime-control.js`)
  that registers `browser_*` and `desktop_*` tools only when
  `runtime.enabled` is true. The browser is driven over the DevTools protocol
  through Node's built-in `WebSocket` and gets its own `--user-data-dir`, so
  there is no npm dependency and no access to the user's cookies or logins. The
  desktop half compiles a `user32.dll` helper with `Add-Type` inside
  `powershell.exe`, posts input without activating the target window by default,
  and only goes foreground on `activate: true` when the config allows it.
  Element lookup accepts visible text, ARIA name, role, CSS selector, or the
  index a previous `browser_elements` returned, and every click and typing call
  screenshots afterwards.
- **Gates and audit.** An emergency stop file refuses every action while it
  exists; `file://`, other non-HTTP schemes, and hosts outside the allowlist are
  refused; file inputs are refused; labels that read submit/delete/pay (or 提交/
  删除/支付) need `confirm: true`. Every attempt writes one audit event with
  action, target, decision, result, rule, and duration — including refusals,
  which used to be indistinguishable from failures.
- **Guard coverage for worker agents.** `lib/guard.js` refuses `browser_*` and
  `desktop_*` calls from bound child agents with rule `guard/runtime-tool`,
  unless `guard.allowRuntimeTools` is set. Runtime control belongs to the
  session that mounted the plugin; a worker driving the user's screen is not
  something to allow by default.
- **Two runnable proofs.** `scripts/runtime-demo.mjs` and
  `scripts/runtime-desktop-demo.mjs` assert against the target's own state (a
  DOM counter, a window's click counter and received characters) rather than
  against the tool's own report.

### Changed

- The default tool set is twelve: `superagent_schedule` joins the existing
  eleven. `bin/doctor.js` and its test expect twelve, and a profile that never
  enables runtime control still sees exactly these twelve.
- `README.md` gained "Goal mode", "Scheduled runs", "Conversation console",
  "User profile", and the plan-honesty and preflight entries under
  "Progress, decisions, and artifacts", and its tool table matches the twelve
  registered tools.

### Fixed

- **Worker checkouts and deliverable verdicts.** A worker starts in its own
  worktree and its prompt names the root that relative paths resolve against.
  A deliverable found only in the base checkout is reported as `misplaced`, not
  `missing` — one means the file was produced in the wrong root, the other means
  it was not produced at all. The worktree pool is anchored to the session's
  sandbox boundary, so a host started from another directory no longer creates
  checkouts outside the workspace it guards.

### Notes

- `README.md` gained a "Runtime control" section that lists the tools, the
  gates, and the boundaries that are real: no borrowing of existing browser
  logins, no CAPTCHA solving, no anti-detection, and no background typing into
  Chromium or Electron content.
- `Add-Type` needs a writable `%TEMP%`. The desktop helper points `TEMP`/`TMP`
  at `%LOCALAPPDATA%/Temp/dsh-runtime-control`, because a restricted token that
  can read `C:\Windows\TEMP` but not write there makes the C# compiler report a
  misleading "source file not found".

## 0.12.1 — 2026-11-15

### Fixed

- **Line endings in `bin/` and `lib/`.** Added `.gitattributes` with
  `*.js text eol=lf` for both directories and normalized the tracked files to
  LF. npm rewrites the shebang line of bin scripts during install (CRLF → LF,
  one byte per file), which made `doctor`'s registry checksum comparison report
  a false `Registry match` failure for `bin/*.js` on npm-installed copies. With
  the tarball now shipping LF, installed files match the published package
  byte-for-byte.

## 0.12.0 — 2026-11-15

### Added

- **Worker safety guard.** Child tool calls are now checked on the host's
  `tools/pre-execute` / `ctx.tools.guard` pipeline. Writes are limited to the
  child's workspace and the OS temp directory; credential stores and
  `.git/config` / `.git/hooks` are refused for reading and writing; system
  directories are refused for writing. Default command rules block disk
  formatting, system scheduler and registry changes, writes into system
  directories, destructive recursive deletes whose target is `/`, `~`, `.`,
  `..`, a wildcard, or outside the workspace, permission nukes, and commands
  that name a credential store. `guard.allowCommands` is an explicit,
  audited override. Blocked calls surface in `superagent_status` and in a
  `## Safety guard` report section. See “Worker safety guard” in the README
  for the full defaults and their rationale.
- **Permission policy.** `<stateDir>/policy.json` (or `policyFile`) lets a person
  say which paths may be written, which commands may run, which action classes
  need a human, and what the default level is per run. The file accepts `//`,
  `#`, and `/* */` comments, validates against a schema, and reports every
  problem with file, line, and column. It only tightens: deny wins, explicit
  allow entries record what they relaxed, and an invalid policy fails closed. A
  start the policy denies is refused before any run record exists; a start held
  for confirmation needs `approve_policy: true`, which is logged.
- **Audit trail.** Append-only JSONL at `<stateDir>/audit/audit.jsonl`: tool
  calls, path writes, commands, blocks, approvals, attention decisions, and run
  lifecycle, each with run id, subtask id, actor, timestamp, decision, result,
  and duration. Appends are serialized in-process and locked across processes;
  a torn tail or a damaged line is reported and skipped instead of hiding the
  log. `audit: false` turns the trail off without changing run behaviour.
- **`superagent_audit`** queries by run, subtask, kind, decision, result, target,
  and time window, and exports the matching events as one JSONL or CSV file.
- `createAuditor(...).attachGuard(fn)` is the seam for a separate path/command
  guard: it can tighten a decision, never relax one.
- `superagent_inject(run_id, message, subtask_index?, wait_seconds?)` steers a
  running child instead of waiting for the next prompt. It calls the host's
  documented live channel (`subagents.sendMessage`, which lands in the same
  `Agent` inbox that `steer`/`inject` expose), so the message is claimed at the
  child's next pre-step and becomes part of its next model request. A child
  that had already decided to stop runs one more turn to read it. Receipts
  record `latencyMs` from acceptance to the claim, or a `missedReason` when the
  child is cancelled, disposed, or finishes before another boundary. On a real
  `dsh@0.2.2-rc.1` host the measured delay was 2986 ms with a 4 s child step
  and 6978 ms with an 8 s step, i.e. bounded by the remainder of the running
  step, not by the plugin. A host without that channel degrades to the followup
  queue and the reply labels it as such.
- **Multi-device sync over git.** `dsh-superagent-sync` turns the state
  directory into a repository and carries it between machines through any git
  remote — no server, no account, no dependency. `init <remote>` writes a
  managed `.gitignore` block (credentials, locks, cancel markers, quarantine
  files, temp files, logs, machine identity) and makes the first commit;
  `pull` fetches and merges, stashing uncommitted local work first and saying
  so; `push` commits local state and pushes, reporting a rejection instead of
  forcing; `status` reports ahead/behind counts, uncommitted files, stashes,
  and conflicted paths. A conflict stops the merge with both sides kept and the
  paths listed — nothing is resolved automatically. Run records were already
  one file per run, so ordinary concurrent work on two machines does not
  collide; the remaining shared surface is an append-only memory scope. The
  README documents the limits: no realtime channel, no cross-machine lock, no
  key distribution.
- **Local workspace panel.** `workbenchPort` (off by default, loopback only)
  serves an IDE-shaped page from `public/workbench.html`: file tree, text editor,
  diff preview before save, and a run view that lists the files a run changed.
  The plugin reads and edits the filesystem itself, so no host API is involved.
  Every request needs the per-process bearer token in `workbench.json`; absolute
  paths, traversal, symlinks out of the root, the state directory, binaries, and
  files above 512 KB are refused with a reason. Saving requires the hash and
  mtime the editor read, so an external edit is never overwritten.
- `dsh-superagent-workbench` runs the same panel standalone, with `--root`,
  `--port`, and `--state-dir`; no host is required.
- Run records now carry `changes` (recorded when the panel is on), which is what
  the panel's run view reads and diffs against `git HEAD`.

## 0.11.0 — 2026-11-15

Runs became something you can talk back to and shape: instructions and answers
reach a run that already exists, planned subtasks can depend on each other,
workers can be isolated in their own worktrees, and the panel and report show
parallel structure instead of opaque rows. Runs are now priced down to the
subtask, spending is kept in a ledger, common goals start from a template, and
an install can check itself. No runtime dependencies were added, and the package
still ships one file per module from `lib/`.

### Added

- **Direct mode.** `superagent_start` takes `mode: "direct"`: one worker does the
  whole goal, with no planner, no aggregation, and no self-heal round, and its
  reply becomes the report verbatim. The run record, quota, deadline, cancel,
  budget, milestones, and per-child usage accounting are identical to a planned
  run. `mode: "planned"` is the default and unchanged.
- **Queueing instead of a hard failure.** `superagent_start` takes
  `queue: true`: when `maxActiveRuns` is in use the run returns
  `status: "queued"` with `queue.position` / `queue.of`, and starts automatically
  when an active run finishes. Waiting runs do not count against
  `maxActiveRuns`, are persisted with an owner heartbeat, start oldest first, and
  renumber when one is cancelled. `maxQueuedRuns` (default 5, 0 disables) caps the
  line and `queueTimeoutMinutes` (default 30) fails a run that never got a slot,
  without spending anything. `queueOnFull: true` makes queueing the default for
  every start; without it a start that does not pass `queue: true` still gets the
  speed quota error.
- **Relevance-ranked memory recall.** `superagent_memory` takes
  `action: "search"` with `query` and/or `tags`; a new note supersedes the older
  one with the same key, and the planner digest now ranks notes against the run's
  goal instead of only taking the newest ones.
- `superagent_followup(run_id, message)` appends an instruction to an active
  run. It stays next-prompt by design: the next worker spawn or the aggregation
  carries it, whichever comes first, and subtasks already running or finished
  keep their results. Each instruction records `appliedAt` / `appliedAtStage`,
  or `missedAt` with a reason when the run settled before another boundary ran.
  A paused run keeps the instruction for its next resume; a completed run
  refuses it. A run owned by another process is refused rather than written,
  because that owner's next save would erase it.
- `superagent_answer(run_id, attention_id?, answer, wait_seconds?)` answers one
  structured attention item. Attention items now carry stable ids (`q1`, `q2`, …)
  from a per-run counter; the answer is recorded on that item and the run
  continues — an active run at its next boundary, a terminal run by reopening so
  its aggregation runs again with the decision. A question retired by a resume
  is archived to `attentionHistory` with `expiredAt`, so a late answer is
  refused as expired instead of being matched to whatever is open now. Unknown
  ids, already answered questions, and an answer whose text is another
  question's option are refused with the id to use instead.
- **Per-worker workspace isolation.** `workspaceIsolation: true` gives every
  worker its own git worktree on `superagent/<runId>-w<n>`, harvested into a
  commit and merged back into the main checkout one at a time. A conflict aborts
  the merge, keeps both branches, and is reported by status and the wake-up
  message. When isolation is unavailable the run continues in the shared
  directory and says so.
- **Dependency-aware plans.** The planner may give a subtask an id and a
  `dependsOn` list. The dependent waits (`waiting`) instead of starting, and its
  prompt carries the finished dependency's report; independent subtasks still
  run in parallel. A dependency on an undeclared task is `skipped` with the
  reason, a failure skips everything downstream instead of reporting it as done,
  and a cycle rejects the plan before any subtask starts. Status, notifications,
  and reports distinguish waiting from running.
- **Parallel structure in the panel and the report.** Runs alive at the same
  moment share a numbered gutter in `watch`, so concurrent work is visible as a
  group, and a waiting row leads with the run holding its slot and its queue
  position. The HTML report lists each worker's retry chain and its share of the
  run's wall clock next to the outcome.
- **Documentation site.** `docs/site/` holds a quickstart, a comparison page,
  and a single-file landing page; nothing in `lib/` changed for it.
- **Per-run and per-subtask pricing.** `pricing` in the plugin config maps a
  model to input/output prices per million tokens. Every run and every subtask
  now carries a `cost` with micro-unit totals, and status, the panel, and the
  report print it (`cost ¥0.3519+`). A model absent from the table is reported as
  `unpriced` — never as `0.0000`, and a total that mixes priced and unpriced work
  is printed with a trailing `+` so it cannot be read as complete.
- **Spend ledger.** `lib/ledger.js` keeps a durable per-run spend record, mounted
  from settled runs so a restart backfills what no tool was watching, and
  `superagent_status` reports the rolling spend and how many runs in the window
  were only partially priced.
- **Workflow templates.** `superagent_template` lists, shows, and expands a
  reusable goal template (built-ins plus files under the template directory), so
  a common goal is expanded into its steps instead of being retyped. Templates
  are optional: a template directory that cannot be created is logged and the
  run tools keep working.
- **Install self-check.** `dsh-superagent-doctor` reports, without installing or
  editing anything, whether every imported file is in the `files` whitelist and
  on disk, whether the installed copy matches its published tarball, whether the
  profile registers the bundle row, and whether all nine tools are registered.
  Every failure prints the command that fixes it. `npm test` also asserts that
  `npm pack --dry-run` ships every file reachable from the entry points
  (`scripts/check-pack.mjs`), which is the check the 0.9.x tarball lacked.
- **Run archives.** `dsh-superagent-archive` (`bin/archive.js`) adds three
  subcommands. `prune` lists terminal runs older than `--older-than <days>`,
  optionally filtered by `--status`, with the files and bytes it would remove;
  it deletes nothing unless `--confirm` is given, and it never touches a run
  that is still active or whose `.lock` another process holds. `export` writes
  one run as a self-contained directory (README with the report, `report.md`,
  `run.json`, per-subtask markdown and JSON, guard records, `usage.json`, and a
  manifest with a SHA-256 per file), as one JSON bundle, or as one offline HTML
  page with the bundle embedded. `import` reads any of those back into the
  store and refuses to overwrite a local run with the same id. `store.js` gained
  `planPrune`, `buildArchive`, `exportRun`, and `importRun`; `prune` gained
  `dryRun` and `statuses` and now returns the plan alongside `removed`. No
  runtime dependency was added.
- New config: `queueOnFull`, `maxQueuedRuns`, `queueTimeoutMinutes`,
  `workspaceIsolation`, `workspaceRoot`, `pricing`.

### Changed

- A single completed subtask still short-circuits aggregation, unless the run
  has instructions or answers: then the aggregation prompt is built, because
  otherwise reopening the run would return the old report and silently drop the
  decision.
- `superagent_resume` reopens a `completed` run only when it holds an answer
  that never reached a prompt; every other completed run keeps its existing
  no-op behaviour. Without this, an answer that could not be applied (quota or
  lock) would be stranded behind a "resume the run" instruction that did
  nothing.
- Status prints the attention id, any recorded answer, and how many instructions
  were applied, are waiting, or never took effect; notifications lead with the
  question id so `superagent_answer` can be called directly.





## 0.10.0 — 2026-11-15

The dispatch, progress, delivery, and memory layer. No runtime dependencies were
added, and the package still ships one file per module from `lib/`.

### Added

- **Cross-run memory.** `<stateDir>/memory/<scope>.jsonl` keeps short notes the
  aggregator writes (`decision`, `pitfall`, `next`, `dispatch`, `note`) plus the
  six most recent runs derived from the run store. The digest is bounded
  (12 notes / 1600 characters / 2600 characters total), compacted above 400
  lines or 128 KB, and injected into the planner and aggregator prompts. A newer
  note with the same key supersedes an older one, `forget` retracts it, and
  notes older than 30 days expire. Secrets are redacted before storage; the
  directory carries its own `.gitignore` and is never in the package.
- Added `superagent_memory` (`list`, `set`, `forget`). Existing tools keep their
  arguments and output; this is the sixth tool.
- **Layered memory.** `rules` and `profile` scopes are read into planning and
  aggregation ahead of the run scope; `superagent_memory` takes `scope`. A run
  only writes its own scope, so a model cannot overwrite a project rule.
- **Duplicate dispatch is collapsed.** The same active goal (case and whitespace
  ignored) returns the existing run id with `deduped: true`, under a per-goal
  claim so two processes sharing a state directory cannot both start it. The
  match is scoped to the owning session, so two sessions that ask for the same
  generic goal still get their own runs. `allow_duplicate: true` on
  `superagent_start` (or `allow_duplicate` on the control `start` body) opts
  out. A `wait_seconds` call keeps the `deduped` marker in its result.
- **Transient backoff.** A rate-limit, quota, timeout, or 5xx failure now waits
  2s, then 4s, then 8s before the next attempt instead of retrying immediately.
- **Recovery note.** A resumed run tells each worker what failed and instructs it
  to inspect files, `git status`, `git log`, and remote state before repeating an
  externally visible action.
- **Structured attention.** A worker or the aggregator may append one fenced
  `attention` block. It is stripped from the report, stored as `attention.items`,
  shown as `needs your decision:` in status, and leads the notification.
- **Attention text is bounded.** Question, options, and reason are collapsed to
  one line and capped at 500 / 200 / 300 characters, so neither status nor a
  notification can be given forged extra lines. An invalid attention block is
  not stripped silently: its raw text stays in the report and status prints
  `attention: <reason>`.
- **Milestones.** `plan_ready`, `running`, `aggregating`, and `settled` are
  recorded with timestamps and shown in `superagent_status`; nothing is pushed.
- **Report file.** A terminal report is written atomically to
  `<stateDir>/reports/<runId>.md` (directory carries `.gitignore: *`), recorded
  in `run.artifacts`, and shown in status. `keepRuns` pruning removes it together
  with the run record.
- **Quiet by default.** Only a delivered, failed, or partially finished run may
  wake the session; a cancelled run never does, and progress is never pushed.
  `maxNotificationsPerHour` (default 3) buffers extra runs into one summary.
- **Notification outbox.** A refused wake-up is retried with backoff
  (`notifyRetries`, `notifyRetryDelayMs`) and messages for one session stay in
  order. A buffered batch is put back into `pending` when the send fails, so a
  later message still carries those runs; it is dropped only after three failed
  deliveries.
- **Self-heal before reporting.** A subtask failure that looks transient
  (quota, rate limit, timeout, 5xx) gets `autoResumeRounds` (default 1) more
  rounds, optionally on `childModelFallback`. The failure message now says what
  was tried, and `self-heal:` appears in `superagent_status`.
- **`memoryMaxEntries` is a compaction trigger.** Exceeding it, 400 lines, or
  128 KB compacts the notebook on the next write.
- New config: `memory`, `memoryScope`, `memoryMaxEntries`, `memoryMaxAgeDays`,
  `memoryDigestEntries`, `memoryDigestChars`, `maxNotificationsPerHour`,
  `notifyRetries`, `notifyRetryDelayMs`, `autoResumeRounds`,
  `childModelFallback`.

### Changed

- **A resume is never refused by the concurrency quota.** A `superagent_resume`
  only finishes work that already exists, so it is not counted against
  `maxActiveRuns` and works even when the cap is full; only `superagent_start`
  creates new spend and is subject to the cap. The resume is still
  session-scoped: it may only be issued by the session named in the run's
  `parentSessionId`. `force` (`force` or `override_quota` over HTTP) is still
  accepted so an existing caller keeps working, but it no longer changes
  anything.
- `superagent_status` gained the milestone line, the attention line, and the
  report file path; `superagent_start` gained `allow_duplicate`; the control
  `start` body gained `allow_duplicate`, and `resume` still accepts `force`.

### Fixed

- Memory, notification, and report-artifact writes are fail-open or retried, so
  a transient filesystem error cannot turn a finished run into a failed one; a
  report that is already written stays on disk and is listed in status.
- Test suite: 168 tests, 0 failures; `npm test` and `node --test` discovery
  agree.

## 0.9.3 — 2026-11-14

Documentation only; no code change.

- Both install commands name the version (`@xiangyixie/dsh-superagent@0.9.3`),
  and the Quickstart explains why: pnpm's minimum release age skips packages
  published in the last few hours, so a bare `add` installs an older version and
  still reports success. A bare install here resolved 0.9.0 while 0.9.2 was
  current.
- Added the command that reports what actually landed:
  `npm ls --prefix <DSH_HOME>/profiles/web @xiangyixie/dsh-superagent`.
- The troubleshooting rows for a missing tool and for
  `Cannot find module .../lib/control.js` now carry the pinned reinstall command.

## 0.9.2 — 2026-11-14

Documentation only; no code change. npm renders the README from the tarball, so
this version exists to put the rewritten opening on the package page.

- The first screen now answers three questions in order: what the plugin is for,
  when it is the wrong tool, and the first command to run after installing.
- `Naming` moved from the top to just above `Development`. The copyright line
  and the "personal project, not affiliated with DeepSeek" statement moved to
  the top, where they are read.
- `Known limits` gained the isolation boundary: children use the host's
  credentials and filesystem and are only as sandboxed as the host makes them.

## 0.9.1 — 2026-11-14

Metadata-only release. No code or behaviour change; the only file contents that
differ are `package.json`, `README.md`, and this changelog.

- Added the `author` field (`Admire (LittleChenLiya)`), matching the copyright
  line in `LICENSE`. The registry metadata carries it from this version on
  (`npm view @xiangyixie/dsh-superagent author`); the npmjs.com package page has
  no separate Author row in its current layout — it lists Collaborators — so the
  visible credit is the copyright line in the README's License section.
- The README "License" section now names the copyright holder, links
  `LICENSE`, and says that the npm scope `@xiangyixie` and the GitHub account
  `LittleChenLiya` are the same author.

## 0.9.0 — 2026-11-14

Hardening pass before the first publish. No behaviour change for the happy
path except the new spending caps, the cost line, and two operator utilities.

### Published as `@xiangyixie/dsh-superagent`

- npm already carries a `dsh-super-agent` that its similarity check treats as
  the same name as the unscoped one, so the first release goes out under the
  author scope. The project, the repository, the plugin row id (`superagent`),
  the five tools (`superagent_*`), the state directory, and both bin names are
  unchanged; only the install specifier differs:
  `dsh plugin --profile web add @xiangyixie/dsh-superagent`.

### Watch panel and HTML report

- `dsh-superagent-watch` draws one line per run — id, status, calls used against
  the cap, elapsed, current activity, parent session — in the alternate screen.
  A status change repaints within 200 ms; an idle panel costs one small file
  read per second. Ctrl-C, SIGTERM, and a closed pipe restore the cursor and
  leave the alternate screen; `--once` prints one plain frame and never takes
  over the screen.
- `dsh-superagent-report` renders recorded runs into one self-contained HTML
  file: inline CSS and inline SVG, no script, no font, no image, no network. It
  contains a timeline with each run's start, end, and derived
  planning/work/merge phases; swimlanes whose count is the peak concurrency;
  cumulative model-call and cost curves; explicit failure, cancellation, and
  interruption annotations; and a run table.
- Neither utility adds a dependency. The package is still `dependencies: {}`;
  the tarball grows from 11 to 15 files (73.4 kB packed, 240.7 kB unpacked).

### Embedding surface (local HTTP)

- New opt-in `controlPort` exposes the five operations as JSON over loopback:
  `GET /`, `GET /health`, `GET /runs`, `GET /runs/:id`, `POST /runs`,
  `POST /runs/:id/cancel`, `POST /runs/:id/resume`. Off by default; `0` picks a
  free port. Another UI can start and watch runs without importing `lib/`.
- Bound to `127.0.0.1` only, with a per-process bearer token written to
  `<stateDir>/control.json` (mode `0600`), a `Host` check that blocks DNS
  rebinding, no CORS headers, a 64 KB body cap, and a 60 s limit on receiving a
  request (a 300 s long poll is unaffected: the wait happens while the response
  is produced).
- Every route goes through the same orchestrator as the tools: quota, budgets,
  run locks, cross-process cancel, and recovery behave identically. `POST /runs`
  requires `session_id` of a live session; a run still needs a real parent agent
  for its children, and a missing session is refused as `no-session` rather than
  started without an owner.
- Replies carry the same `text` as the tool result, plus the stored run object
  (`schemaVersion: 1`). Transport errors have their own ids (`unauthorized`,
  `forbidden-host`, `no-session`, `body-too-large`, …) so a client can tell a
  bad token from a broken run.
- The contract, security model, and client examples are in
  [docs/embedding.md](https://github.com/LittleChenLiya/dsh-superagent/blob/main/docs/embedding.md);
  verified against real `dsh@0.2.2-rc.1` with 17 checks in
  `docs/e2e/transcripts/control-plane.log`, plus a two-host cross-process cancel
  run in `docs/e2e/transcripts/cross-cancel.log`.
- Review fixes before release: a dispose that lands while the port is still
  binding now closes it instead of leaving an orphaned listener; a failed
  discovery write closes the server instead of running unreachable; `/health`
  does no state work, so a liveness probe cannot reclaim runs; a blank goal is
  a 400 `no-goal` and a profile without a subagent service is a 503
  `no-subagents` instead of a 500.
- A second review pass added: the plane starts only after the state directory
  exists (a fresh `DSH_HOME` used to leave it off for the whole host lifetime);
  discovery files carry a per-plane `instanceId`, so a reloaded plugin does not
  delete the newer plane's file; a concurrent `start()` shares one listener;
  `GET /runs?limit` also limits the returned array; a missing goal is reported
  before a missing session; a worker session is refused by `superagent_cancel`
  as well; and a malformed `controlPort` (`""`, `" "`, `true`) can no longer
  coerce to an accidental listener.

### Renamed to `dsh-superagent`

- The package, repository, plugin row id (`superagent`), default state
  directory (`state/superagent`), log prefix, and all five tools
  (`superagent_*`) moved from the working name `dsh-longhaul`.
- Nothing was ever published under the old name, so there is no migration and
  no compatibility alias: `longhaul_*` calls simply do not exist. A run started
  under the old default state directory is still readable by pointing
  `stateDir` at it.

### Cancellation

- `superagent_cancel` now stops the run when it is called from a different
  process. The caller writes a `<runId>.cancel` marker; the owning process polls
  it once per second, aborts its children, disposes their activations, and
  records `cancelled`. The caller waits up to 5 s and reports
  `cancel requested ... not confirmed` instead of claiming a success it cannot
  observe.
- Recovery converts a marked run to `cancelled` rather than `interrupted`, and
  `superagent_resume` clears a stale marker.

### Spending

- New hard budgets `maxModelCallsPerRun` (80) and `maxTokensPerRun` (2,000,000),
  checked before every child spawn. Hitting one stops spawning: the run ends
  `partial` when at least one subtask finished and `failed` when none did, keeps
  the reports that did finish, and leaves the rest `pending` for a resume.
- A tool's `max_subtasks` / `max_parallel` / `deadline_minutes` can narrow the
  configured cap but never widen it: the config stays the operator's control.
- New `pricing` table (per 1M tokens, per model) and a `cost` field on every
  run. Unpriced models are named and excluded instead of being estimated.
- `usage: not recorded` now explains why instead of printing two bare words.

### Robustness

- A run file that is not valid JSON is quarantined as
  `<runId>.json.corrupt-<ts>` and skipped by listings; asking for it by id
  reports the quarantine path. Stale `.tmp` files (over 10 minutes) and cancel
  markers for terminal runs are removed at mount.
- Orphaned runs no longer hold the active-run quota: a run with a heartbeat
  older than 90 s is reclaimed, using the owner pid only when the state
  directory belongs to this machine, and recording the exact basis on the run.
- Tool errors are now `[error] <sentence>` / `hint: <next step>` /
  `detail: <untouched host message>`, covering 19 known failure shapes,
  including the Windows ACL sandbox launcher.

### Notifications and retention

- The notify outcome is recorded on the run (`delivered`, `reason`) and shown
  by `superagent_status` / `superagent_list` when a finished run could not reach its
  session.
- New opt-in `keepRuns` deletes terminal runs older than N days at mount.
  `superagent_list` prints the state directory's file count and size.

### Concurrency and recovery

- Mount-time recovery no longer rewrites a run that another process is still
  running. Ownership is decided once, in `ownership()`: a fresh heartbeat, a
  live local pid, or a live local process holding the run lock all veto
  reclamation. Two profiles can share one state directory without overwriting
  each other's runs.
- `superagent_resume` is now exclusive. It takes the same serial gate as
  `superagent_start`, claims `<runId>.lock` atomically, re-reads the run under
  that lock, refuses a run that still has a live owner, and applies the
  `maxActiveRuns` check. Two concurrent resumes, or a resume in a second
  process, can no longer run the same subtasks twice.
- A lock left by a dead process on this machine is broken immediately; a live
  local process keeps its lock however long the run takes; a lock from another
  machine is broken after 10 minutes, because its pid cannot be checked.
- `maxActiveRuns` is clamped to an integer (1–8), so a config value such as
  `"abc"` falls back to the default instead of making the quota `NaN`.
- A cancel from another process is reported by `superagent_status` as
  `cancel requested ... not confirmed` (read from the marker) instead of being
  invisible until the owner saves.
- A child whose provider never answers can no longer pin a run in
  `planning`/`running`: the spawn is abortable, so cancel and the deadline take
  effect, and a child that appears after the abort is disposed at once.
- The terminal status and its notify outcome are written in a single save, so a
  reader never sees a finished run without its notify row. Waking the session is
  bounded (15 s) and the heartbeat keeps running until the terminal write lands,
  so a slow wake-up cannot make another process reclaim a live run.
- Resuming a run now rebuilds `limits` from the current config while keeping
  the spend so far, so raising a cap and resuming actually works.
- `runtime`, `saveChains`, and remembered child ids are released when a run
  ends instead of growing for the life of the host.

### Child safety

- Children are capped with `maxSubagentDepth: 1` by default (passed to the host
  as `maxDepth`); a provider that cannot enforce it fails the start with an
  explicit error rather than running unbounded. `childPreset` is the supported
  way to narrow a child's tools. dsh 0.2.2-rc.1 has no per-run tool allowlist —
  its start request has no tool filter — so the plugin documents that limit
  instead of pretending to enforce one.

### Real-host end-to-end (2026-11-14)

The first run against a real `dsh@0.2.2-rc.1` host (keyless stub model, full
record in `docs/e2e-2026-11-14.md`) found four behaviours that the offline
suite could not see:

- **A graceful host shutdown buried resumable work as `failed`.** When the
  `subagents` service disappears mid-run (a one-shot headless turn ends),
  children throw "service unavailable". That used to burn both attempts and
  settle the run `failed`. It is now recognised as the host going away: the
  unfinished subtasks stay `pending`, no attempts are spent, and the run
  settles `interrupted` with `note: the host shut down while this run was
  active`. `superagent_resume` picks it up in the next host.
- **A dead pid was ignored for 90 s.** `ownership()` trusted a fresh heartbeat
  before checking the owner pid, so a `kill -9` left the run `running` for a
  minute and a half on the very machine that could prove the pid was gone. On
  a run written by this machine, a dead pid now wins over the heartbeat; a run
  from another machine on a shared directory still trusts the heartbeat.
- **A reclaimed run claimed its cost was unknown.** Recovery now republishes
  `run.usage` from `usageByChild` and recomputes `cost`, so an interrupted run
  shows the money already spent instead of "not computed".
- **Per-subtask usage was often `null` after a normal run.** The read at child
  completion can race the log flush; the settle pass now writes the final
  per-child snapshot back onto each subtask.

Also: the plugin no longer ships a price for `qwen-flash` (the README already
promised that nothing is priced out of the box); the table is empty unless the
profile configures one.


### Install and first run

- Requirements corrected to what `dsh@0.2.2-rc.1` needs: Node `>=24.9.0`, and
  the default route's `DEEPSEEK_API_KEY` (not a DashScope key).
- Quickstart no longer tells people to `npm i -g dsh` (that is an unrelated
  package); it uses `npx @deepseek-ai/dsh@0.2.2-rc.1` and
  `dsh plugin --profile web add @xiangyixie/dsh-superagent`.
- `usage: accounting pending` while a run is active; `usage: not recorded` only
  on a finished run whose logs are unreadable. `interrupted` runs print the
  `superagent_resume` next step, cancelled runs show unstarted subtasks as
  `skipped`, and elapsed time separates running time from downtime.
- Pricing keys match `provider/model` exactly, then by bare model name, so a
  `qwen-flash` entry also prices `dashscope/qwen-flash`.
- An unusable state directory is reported by every tool instead of appearing as
  an empty run list; `ENOENT`/`ENOTDIR` are classified as filesystem errors.
- Missing credentials and unknown model ids have their own classifications and
  hints. The auth hint names the default route's key first.
- The plugin mounts even without the `subagents` service (that dependency is
  optional), and `superagent_start` then explains what is missing instead of the
  five tools silently disappearing.
- `exports` only advertises the plugin entry point; the undocumented internal
  subpaths that shipped without types are gone.

### Tests

- 86 offline tests (`npm test`): fake store, fake child spawner, no network, no
  API key. Covers cross-process cancel, orphan reclamation in both local and
  shared modes, concurrent and cross-process resume, resume quotas and limit
  rebuilding, budgets with and without readable usage logs, pricing keys, a
  child that ignores abort, notify ordering, corrupted state, a missing state
  directory, retention, error text, usage-log reading, the HTTP control plane
  (auth, transport errors, discovery lifecycle, start/stop races), and a full
  plugin mount. Polling-based tests were rewritten around event gates; five
  consecutive full runs pass.
