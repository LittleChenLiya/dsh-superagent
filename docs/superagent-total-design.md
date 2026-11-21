# 超级智能体 · 总设计实施说明

本文件对应本地分支 `feat/superagent-total-design`，从基线提交
`45f6923bc0d32eb16a6633fb1fee892c7f29426d`（`D:/Codex/dsh-superagent/delegation/integration/src`）
建独立工作树 `D:/Codex/dsh-superagent/total-design/src`。

总设计图：[superagent-total-design.svg](assets/superagent-total-design.svg)。

## 一、工作图与事实

`router.json` 中的 `facts` 是当前状态的唯一事实来源。每条事实包含：

| 字段 | 含义 |
| --- | --- |
| `project` / `taskId` / `phaseId` | 作用域；阶段可空，表示整个任务 |
| `kind` / `key` / `subject` / `value` | 别名、决定、证据或来源事件 |
| `origin` | `user`、`run`、`external` |
| `source` / `sourceId` | 用户消息、任务回答、运行、GitHub/飞书事件 |
| `confirmedAt` / `validFrom` / `observedAt` | 确认、生效、观察时间 |
| `expiresAt` | 到期时间；读取时判断，不改写历史 |
| `replaces` / `revoked` | 更正指向被替换记录；撤回写入墓碑 |

要点：

- 同一作用域和主题只有最新值生效；更正自动记录 `replaces`。
- 撤回必须来自明确用户动作（`/撤销决定`、`/撤销别名`），外部文本不会产生决定。
- 阶段归属：命令中出现某一阶段标题时，决定只注入该阶段；未点名则作用于整个任务。
- 运行终态（完成、失败、取消）自动写成 `kind: evidence`、`origin: run` 的证据。
- 外部事件正文按数据处理，记录为 `kind: source`、`origin: external`。
- 旧 `router.json`（无 `version`、事实无 `origin`）可直接读取；`migrateState` 幂等，
  写入时持久化为 `version: 2`，崩溃后可安全重试。

### 常用确定性查询

```
/状态 发版
/方案 发版
/证据 发版
/别名 发版 | 发布说明
/决定 发版 | 兼容性策略 | 先查旧版 | 7天
/撤销决定 发版 | 兼容性策略
```

这些命令直接读记录，不调用模型。任务名重名时只列出有限候选并澄清一次；
不会猜测目标。

### 注入执行线

`readTaskDecisions` 只返回该任务当前有效的已确认事实，并按阶段过滤，最多 6 条。
过期、撤回、跨工作区和其他阶段的事实都不会进入执行提示词。

## 二、GitHub / 飞书来源

入口在控制台 HTTP 服务上，只有 `/hooks/github`、`/hooks/feishu` 不走控制台令牌，
改用来源自身认证。处理顺序固定：

1. 校验签名、时间窗和握手；
2. 归一化为有界记录；
3. **先持久登记**到 `sources/sources.json`，再返回 2xx；
4. 用 `source:instance:deliveryId` 去重；
5. 命中显式绑定且授权有效时，用稳定请求 ID 直通路由器；
6. 崩溃后扫描 `registered` / `dispatching` 事件，重放同一 ID，路由器幂等去重。

未绑定事件只登记为 `unbound`；绑定需要 `autoStart: true` 才允许新建任务，
默认关闭。绑定撤销后事件不再派工。该能力只读外部事件，不向 GitHub / 飞书写回。

### 配置

来源默认关闭。在超级智能体插件的 profile 配置中显式开启，凭据只写环境变量名：

```json
{
  "consolePort": 4317,
  "sources": {
    "enabled": true,
    "github": {
      "enabled": true,
      "instanceId": "default",
      "secretEnv": "DSH_GITHUB_WEBHOOK_SECRET"
    },
    "feishu": {
      "enabled": true,
      "instanceId": "default",
      "encryptKeyEnv": "DSH_FEISHU_ENCRYPT_KEY",
      "verificationTokenEnv": "DSH_FEISHU_VERIFICATION_TOKEN"
    }
  }
}
```

```powershell
$env:DSH_GITHUB_WEBHOOK_SECRET = '<github webhook secret>'
$env:DSH_FEISHU_ENCRYPT_KEY = '<feishu encrypt key>'
$env:DSH_FEISHU_VERIFICATION_TOKEN = '<feishu verification token>'
```

缺少对应环境变量时，hook 返回 503，而不是接受未签名请求。控制台只监听回环地址；
真实公网接入需要 HTTPS 反向代理或隧道，把公开地址转发到
`http://127.0.0.1:<consolePort>/hooks/github` 或 `/hooks/feishu`。

### 绑定

控制台 API（需要控制台令牌）：

```text
GET  /api/console/sources
POST /api/console/sources/bind
     { "source": "github", "objectId": "github:101:issue:7",
       "project": "<workspace cwd>", "taskId": "<goal id>", "phaseId": "<phase id>",
       "allowFollowup": true, "autoStart": false }
POST /api/console/sources/unbind
     { "id": "<binding id>" }
```

`objectId` 由来源原生标识组成：GitHub 为 `github:<repo.id>:<kind>:<编号>`，
飞书为 `feishu:<tenant_key>:message:<message_id>`。不同仓库或租户的同号对象
不会共享绑定。

## 三、注意力界面

- 任务卡「工作上下文」按来源、当前决定、证据分组显示，带阶段与时间；有来源时
  不再只显示“还没有别名或已确认的决定”。
- 回执区分 `已登记`、`已送达`、`已验收`、`需要你决定` 四种状态，使用稳定消息 ID。
- 来源事件不写入对话、不抢焦点，只补充任务图；后台任务完成只更新任务详情。
- 待办继续来自审批、无法继续的阻塞和关键决定，沿用现有稳定 ID，重启与重投不重复提醒。
- 输入框草稿、工作区隔离和窄窗布局未改动。

## 四、运行与验收

本次环境：Windows，Node `v24.14.1`；测试与验收状态全部写入
`D:/Codex/dsh-superagent/total-design`，未占用 C 盘。

```powershell
cd D:/Codex/dsh-superagent/total-design/src
node --test test/work-graph.test.mjs test/attention-policy.test.mjs `
  test/sources.test.mjs test/router-attention.test.mjs `
  test/github-events.test.mjs test/client-bundle.test.mjs test/console.test.mjs

$env:DSH_ACCEPTANCE_DIR='D:/Codex/dsh-superagent/total-design/acceptance'
node scripts/demo-acceptance.mjs

# 真实宿主演示（独立 profile；模型为确定性模拟）
node D:/Codex/dsh-superagent/total-design/host-demo/runner/run.mjs

git diff --check
$env:npm_config_cache='D:/Codex/dsh-superagent/total-design/npm-cache'
npm run check-pack
```

验收脚本使用本地合成数据和显式声明的模拟分类器/执行器，**不调用真实模型**。
GitHub / 飞书事件通过真实回环 HTTP 服务器进入 `ingress.handle`，签名和飞书
AES 加密均为本地夹具。

### 验收记录（2026-11-21）

- 分支：`feat/superagent-total-design`
- 基准提交：`45f6923bc0d32eb16a6633fb1fee892c7f29426d`
- 结果：`scripts/demo-acceptance.mjs` **14/14 通过**
- 报告：`D:/Codex/dsh-superagent/total-design/acceptance/acceptance-report.md`
  （另有 `acceptance-report.json`）
- 覆盖：跨工作区隔离、重启后读取、阶段隔离、撤回、终态验收、证据查询、
  旧状态迁移、GitHub 签名事件入站、重投去重、未绑定不派工、飞书签名/握手/加密、
  跨租户隔离、登记后崩溃恢复、回执四态。
- 失败与修复：首次验收在 Windows 上遇到 `EPERM ... rename router.json.tmp`；
  已为 `router.json` 与 `sources.json` 的原子替换加入 `EPERM/EACCES/EBUSY`
  有限重试，复跑通过。

### 真实宿主演示（2026-11-21，隔离实例）

**结论：真实宿主观察通过；模型调用是模拟。** 本轮用独立 `DSH_HOME`、独立 profile、
独立 `stateDir` 和两个独立工作区启动桌面宿主主进程（`ELECTRON_RUN_AS_NODE=1`，
未开可见窗口），没有触碰 desktop profile、正在执行的任务和主工作区。
对话、规划和执行由确定性 `dsh-host-demo-stub`（路由 `demo-stub`）应答，**不是真实 LLM**；
GitHub / 飞书使用本地签名或加密夹具，**没有连接真实账号**。

| 任务 | 执行线 | 阶段 | 结果 |
| --- | --- | --- | --- |
| `发布验收` | `session-superagent-e8ee…` / `release-project` | `p1 准备发布说明`、`p2 复核发布说明` | 两个阶段完成；阶段运行均属于该 session |
| `反馈核查` | `session-superagent-4c3a…` / `feedback-project` | `f1 核对反馈范围` | 完成；阶段运行属于该 session |

阶段输入从宿主实际发给模型的 15 次请求中核对：

- p1 起始提示含 `This run is phase 1 of 2: 准备发布说明`；后续补充请求含
  `先只检查阻断项`，不含 p2 的决定或补充。
- p2 起始提示含 `This run is phase 2 of 2: 复核发布说明`、`复核只看差异清单`、
  `FOLLOWUP-P2`；不含 p1 的决定或补充。
- `router.json` 中两条决定事实的 `phaseId` 分别为 `p1` / `p2`，与工作图阶段一致。

来源事件：

- GitHub 签名事件 → HTTP 202，`dispatched`，source 事实归属 `p2`，正文进入 p2
  执行线；对话新增消息 **0**。
- 飞书握手 + AES 加密事件 → challenge 匹配、HTTP 200，`dispatched`，source 事实
  归属 `f1`，正文进入反馈执行线；对话新增消息 **0**。
- 两条事件均未进入对方执行线，对话中也没有事件正文。

演示中发现并修复两处问题：

1. 来源事件绑定到阶段时，`kind: 'source'` 事实原先不带 `phaseId`，工作图丢失阶段
   归属；已在 `lib/router.js` 记录绑定阶段，并在合成验收中增加断言。
2. `consolePort: 0`（系统分配端口）被日志误判为关闭；已改为只在 `null` 时提示，
   端口 0 记为 ephemeral port。

结构化观察、原始模型请求、宿主日志与状态文件在
`D:/Codex/dsh-superagent/total-design/host-demo/`；完整报告为
`D:/Codex/dsh-superagent/total-design/acceptance/host-demo-report.md`。

### 真实账号连通性

**未验证。** 本地没有可用的真实 GitHub webhook secret、飞书应用凭据或公网回调地址，
所以当前只验证到：官方签名算法、时间窗、握手、AES 解密、持久登记、绑定与恢复路径。
要完成真实连通性验证，需要：

1. 用真实 secret 配置 GitHub webhook，指向公网可达的 `/hooks/github`；
2. 在飞书开放平台订阅 `im.message.receive_v1`，配置同一加密 Key 与 Verification Token；
3. 在控制台为目标仓库/租户对象建立绑定；
4. 触发一次真实事件，确认 `GET /api/console/sources` 中状态为 `dispatched`，
   任务卡出现来源记录，且对话没有新增消息。

## 五、已知边界

- 只接收外部事件，不回写 GitHub / 飞书。
- 自动开工必须显式 `autoStart`，默认关闭。
- `package.json` 版本仍为 `0.24.0`；任务描述提到已安装 `0.25.0-dev.7`，两者不一致，
  本次未改版本号。
- 本轮补做了隔离真实宿主演示：使用独立 `DSH_HOME`、profile、`stateDir` 和两个演示
  工作区；未改动 desktop profile、正在执行的任务或主工作区。模型为确定性模拟，
  GitHub / 飞书为本地签名夹具，真实账号连通性仍未验证。
