# 宿主兼容点清单

插件声明的宿主范围是 `package.json` 里的 `engines.dsh`：`>=0.2.2-rc.1 <0.3.0-0`。
rc.1 与 rc.3 的子 agent 接口形状不同，插件不按版本号分支，而是按"读到什么形状就用什么"
的方式兼容。下面每一行都是下次宿主升级时要逐条核对的点。

## 1. 启动请求（startActivation）

| 兼容点 | 形状差异 | 位置 | 插件怎么兼容 | 下次检查 |
| --- | --- | --- | --- | --- |
| delegation 字段位置 | rc.1 从 `spec.request` 读 `parent`/`prompt`/`signal`；rc.3 从 spec 顶层读。只发 `request` 时 rc.3 抛 `Cannot read properties of undefined (reading 'id')`，子 agent 还没建就崩 | `lib/index.js:1560-1628` | 同一份字段双写：`{ request, ...request, signal, delivery: 'caller' }`，两边各读自己认的键 | 起一次带子任务的 run，确认 `startActivation` 不抛错；若宿主新增必填字段，两处都要补 |
| `agentPreset` | 只有声明了 `agentPresets` 注册表的 profile 才能落 preset | `lib/index.js:1570-1588` | 先 `ctx.get('agentPresets')` 探测，再查 `provider.capabilities.agentPreset`；缺任一项就明确报错，不静默继承父会话工具 | 精简 profile 里跑一次，确认报错文案而不是"子 agent 拿到全部工具" |
| `maxDepth` | 只有 `capabilities.depthLimit` 的 provider 能限制递归深度 | `lib/index.js:1592-1601` | 能力缺失时报错，要求显式配置 `maxSubagentDepth: provider-managed` | 换 provider 后确认递归上限仍然生效 |
| `cwd` | 相对路径按子会话目录解析 | `lib/index.js:1567` | 传绝对路径 | 隔离模式下验证交付物落在 worktree 而不是父目录 |

## 2. 子 agent 返回句柄

| 兼容点 | 形状差异 | 位置 | 插件怎么兼容 | 下次检查 |
| --- | --- | --- | --- | --- |
| 句柄字段 | 期望 `{ childId, result, dispose() }`；`dispose()` 可能抛错，`result` 可能因提前释放而缺失 | `lib/index.js:1632-1646` | `dispose` 包 try/catch 只记日志；`result` 缺失按失败尝试处理 | 跑一次被超时打断的 planner，确认日志而不是崩溃 |
| `result.output` | 文本块数组（`ContentBlock[]`），不是字符串 | `lib/orchestrator.js:211-219`（`textOf`） | 只取 `type === 'text'` 的块再拼接；非数组返回空串 | 宿主若改成直接返回字符串，`textOf` 需要同时接受字符串 |
| 结果缺失 | 被释放的子 agent 可能不带 `result` 就 settle | `lib/orchestrator.js:3373-3380` | 记 `planner-empty` 失败原因，不读 `undefined.output` | 同上 |

## 3. 宿主服务形状（全部按存在性探测，不做注入声明）

| 兼容点 | 形状差异 | 位置 | 插件怎么兼容 | 下次检查 |
| --- | --- | --- | --- | --- |
| `subagents` | 可能没有该服务，也可能在插件之后才注册 | `lib/index.js:1267-1279`、`1833` | 调用时 `ctx.get('subagents')` 取，取不到再退回 `ctx.subagents`；缺失时工具照常挂载并解释缺什么 | `doctor` 里看 provider 一行；精简 profile 应报"缺服务"而不是少工具 |
| `agents.resume / agents.create` | 调度器要在重启后找回计划所属会话 | `lib/index.js:1316-1324`、`1670-1721` | 依次尝试 `agents.resume` → `sessionController.resolveAgent` → `agents.create` → `session.create` → 放弃并记日志 | 重启宿主后让定时计划触发一次 |
| `sessionController` | 控制台与调度器共用；不同宿主可能没有 | `lib/index.js:1296-1308` | 同上，存在性探测 + 直接属性回退 | 控制台路由是否仍能拿到会话 |
| `session.append / follow / observeState` | rc.1 与 rc.3 的方法集不完全一致 | `lib/index.js:1461-1493`、`3326`、`3359` | 每个方法单独探测；缺 `append` 时命令提权退化为继承父会话权限并记日志 | 命令类子任务在无 `append` 的宿主上应降级而不是失败 |
| `sandboxPolicy.overrideOf / defaultMode` | 命令提权需要同步读写父会话沙箱模式 | `lib/index.js:1461-1483` | 两个都可用才做"追加-启动-回滚"的同步窗口，否则记日志并继承 | 断言提权窗口内没有 `await` |

## 4. 预设（preset）相关

- 宿主预设行只暴露 `id` / `isDefault` / `name` / `description` / `broken` / `order`
  （`packages/preset/agent-preset-registry/src/types.ts` 的 `AgentPresetRow`），**没有**
  `hidden` / `internal` 字段；客户端唯一的过滤是 `requiresCodingTools`，只对内置
  `ptc` / `minimal` 生效。
- 因此插件声明的 `planner` 预设无法从用户可选列表里移除，只能靠 `name`（中文标注
  "请勿选择"）、`description` 和 `order: 9999` 排到最后来降低误选（见 `cordis.patch.yml`）。
- 不能改成"不给 planner 传 preset"：`SubagentStartRequest` 没有 `toolFilter`，去掉 preset
  等于让规划子 agent 继承父会话的全部工具。宿主哪天在启动请求里加了工具过滤/隐藏预设，
  这里才能去掉对预设行的依赖。

## 升级时怎么验

1. `npm test`（465 项，含 budget 与并发语义）。
2. 重启宿主后跑 `superagent_status`，`doctor` 应为 0 fail。
3. 用任意三路子任务的目标跑一次真实 run，确认：同级三路真的同时开始、有依赖的步骤仍按序、
   日志里没有 `startActivation` 崩溃。
4. 若宿主改了 `SubagentStartRequest` 字段（`packages/subagent/subagent/src/types.ts`），
   回到第 1 节逐行对照，优先检查 `parent` / `prompt` / `signal` 的读取位置。
