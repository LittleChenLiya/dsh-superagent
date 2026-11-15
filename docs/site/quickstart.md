# 从零到跑通第一个 run

面向第一次装这个插件的人。每一步都给出命令和"应该看到什么"；命令可以直接照抄。
版本按 `0.9.3` 写。文中出现的 run id、token 数和费用来自仓库内的真实运行记录，
你自己的数字会不一样。

> 约定：下面用 `dsh` 指代宿主命令。如果 `dsh` 不在 `PATH` 上，把它换成
> `npx @deepseek-ai/dsh@0.2.2-rc.1`。**不要** `npm i -g dsh`，npm 上的 `dsh`
> 是另一个包（"a shell written in JavaScript"），与本插件无关。

---

## 第 1 步：确认 Node 和宿主版本

```bash
node -v
```

应该是 `v24.9.0` 或更高。宿主本身低于这个版本会拒绝启动，插件跟着拒绝。

```bash
npx @deepseek-ai/dsh@0.2.2-rc.1 --version
```

记下这个版本号。插件支持 `>= 0.2.2-rc.1 < 0.3.0`；版本对不上时，先解决宿主，
再装插件。

---

## 第 2 步：把插件装进一个 profile

```bash
dsh plugin --profile web add @xiangyixie/dsh-superagent@0.9.3
```

`web` 换成你实际用的 profile（`headless` 也可以）。三个容易踩的点：

1. **必须写版本号。** 不写版本时，pnpm 的"最小发布年龄"策略会跳过几小时内刚发布的
   版本，装到一个旧的，命令仍然显示成功。
2. **这不是全局 CLI。** 它的安装路径是 `dsh plugin add`，不是 `npm i -g`。
3. **装完要重新 `add` 才能更新。** 用 `file:` 装本地 checkout 时，源码改了要重跑这条
   命令，profile 里留着的是拷贝。

离线机器或固定制品，用打包文件，内容与 registry 上的逐字节一致：

```bash
npm pack
dsh plugin --profile web add ./xiangyixie-dsh-superagent-0.9.3.tgz
```

---

## 第 3 步：确认插件真的挂载了

```bash
dsh --profile web --dump-config
```

在输出里找这两行：

```yaml
# == @xiangyixie/dsh-superagent
- id: superagent
  name: @xiangyixie/dsh-superagent
```

找不到这个块，说明包装上了但没挂载，工具不会存在。再确认一下实际落地的版本：

```bash
npm ls --prefix ~/.dsh/profiles/web @xiangyixie/dsh-superagent
```

（Windows 上是 `%USERPROFILE%\.dsh\profiles\web`；如果你设了 `DSH_HOME`，
换成 `$DSH_HOME/profiles/web`。）

---

## 第 4 步：在启动宿主的环境里放 API key

key 必须放在**启动宿主那个进程**的环境里，而不是另开一个窗口 export 完就算了。

```bash
# bash / zsh
export DEEPSEEK_API_KEY=sk-...
dsh --profile web
```

```powershell
# PowerShell
$env:DEEPSEEK_API_KEY = "sk-..."
dsh --profile web
```

默认 profile 走 `deepseek-official` / `deepseek-flash`，读 `DEEPSEEK_API_KEY`。
profile 指向别的路由时，变量名跟着路由变（DashScope 是 `DASHSCOPE_API_KEY`）。

启动后第一屏应该出现插件自己的两行日志，第二行里的路径就是后面所有命令要用的
state 目录：

```text
[dsh-superagent] registered 6 tools; state C:\Users\you\.dsh\state\superagent
```

只看到别的东西、没有 `[dsh-superagent]` 行，去宿主日志里搜这个前缀。

---

## 第 5 步：发一条目标

在会话里直接说，不用记语法：

> Use superagent_start with goal "Explain the difference between process and thread in 300 words, with one concrete example" and wait_seconds 120

`wait_seconds` 是"最多等这么久"。跑完会直接返回终态；没跑完就返回一行
`next: superagent_status run_id="…"`，run 在后台继续，不会因为这次调用结束而停。

---

## 第 6 步：读懂返回的 run 块

真实输出长这样（数字来自一次真实付费 run，你的会不同）：

```text
run 20261114T105744-e272 — completed
goal: In one sentence, state the difference between a process and a thread
plan: planned; subtasks 1/1 completed; max 2 in parallel; 2 attempt(s) each
elapsed: 38.6s
usage: input 1882 (+19456 prompt tokens served from cache), output 7363, calls 3
cost: ¥0.1016 (estimate; all models priced)
  [1] completed (attempts 2) Write one-sentence process-vs-thread distinction 31 in / 1657 out

report:
...
```

逐行看：

- `run <id> — <status>`：`completed` 之外还会出现 `partial`（有子任务没成但也交出了
  部分结果）、`failed`、`cancelled`、`interrupted`。
- `plan:`：规划是否成功、子任务完成数、并行上限、每个子任务允许几次尝试。
- `usage:` 与 `cost:`：实测 token 与估算费用。`cost` 只有在你配了价格时才出现数字，
  否则是 `not computed — no price configured for …`。
- `[n]` 行：每个子任务的结果与尝试次数。失败的那个会带原因。
- `report:` 之后是合并后的报告正文。终态 run 还会把报告写到磁盘：

```text
<stateDir>/reports/<runId>.md
```

---

## 第 7 步：看 run 面板

另开一个终端，不需要连会话，也不需要宿主还活着：

```bash
PKG="${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/@xiangyixie/dsh-superagent"
node "$PKG/bin/watch.js"
```

```powershell
$PKG = "$HOME\.dsh\profiles\web\node_modules\@xiangyixie\dsh-superagent"
node "$PKG\bin\watch.js"
```

一行一条 run：id、状态、已用调用数对上限、已耗时、当前在干什么、父会话。
`Ctrl-C` 退出会恢复光标。只想拍一张快照、不要全屏刷新，加 `--once`：

```bash
node "$PKG/bin/watch.js" --once
```

```text
RUN ID               STATUS       CALLS    ELAPSED ACTIVITY
20261114T090200-7eee interrupted  4/80     2m00s   host went away · resume to continue
20261114T090204-686a cancelled    3/80     1s      cancelled by request
20261114T090106-a188 completed    4/80     931ms   report ready · 2/2 subtasks
```

状态目录不在默认位置时加 `--state-dir <path>`，两个参数顺序随意。

---

## 第 8 步：看报告

```bash
node "$PKG/bin/report.js" --out report.html
```

```text
wrote C:\...\report.html (82.4 kB, 40 runs)
```

双击打开就是完整一页：时间线、并发泳道、累计调用与费用曲线、失败/取消/中断标注、
run 表。文件是自包含的——内联 CSS 和内联 SVG，没有脚本、字体、图片和网络请求。
`--limit 0` 收全部 run，`--limit 20` 只要最近 20 条。

状态目录里一条 run 都没有时，命令会以退出码 1 结束并提示先跑一条，这是预期行为。

---

## 第 9 步：配预算和价格（建议在第一次付费前做）

编辑 profile 的补丁文件（默认在 `~/.dsh/profiles/web/cordis.patch.yml`）：

```text
$DSH_HOME/profiles/web/cordis.patch.yml
```

```yaml
- id: superagent
  config:
    maxParallel: 3
    maxModelCallsPerRun: 80
    maxTokensPerRun: 2000000
    pricing:
      deepseek-official/deepseek-flash:
        input: 0.28          # 每 100 万未命中缓存的输入 token，单位见 currency
        output: 0.42
        cacheRead: 0.028     # 可省，默认按 input 计价
        currency: CNY
```

- 价格**必须自己填**，插件不自带任何模型价格，因为过期价格比没有价格更糟。
- 键名要和 `usage:` 行里的 `provider/model` 完全一致，直接从那一行抄。
  先精确匹配，再退到裸模型名。
- 上面三个数字是占位，按你自己的账单填。
- 改完重启宿主。

两条硬预算都在每次 spawn 之前检查：触顶就不再起新子代理，正在跑的被 abort，
已完成的报告照常合并；run 结束为 `partial` 或 `failed`，报 `budget reached (n/m)`。
要接着跑就调高上限再 `superagent_resume`——已花掉的部分保留，不会重算。

---

## 第 10 步：演练一次中断恢复

不用真出事故，杀进程就行。

1. 发一条会跑得久一点的目标，`wait_seconds 5`，让它返回 `next: superagent_status …`。
2. 直接杀掉宿主进程。
3. 重新启动宿主。
4. 查状态：

   > Call superagent_status with run_id "<刚才的 run id>"

   应该看到 `interrupted`，并且带一行判定依据，例如
   `reclaimed: owner pid 33204 is not running and this state directory is local`。
   中途在跑的子任务回到 `pending`，已完成的保留原 child id。

5. 续跑：

   > Call superagent_resume with run_id "<同一个 run id>" and wait_seconds 120

run 接着跑到 `completed`，累计花销是两次的和，规划不会重做。

---

## 卡住时的三条路

| 现象 | 先看这里 |
| --- | --- |
| `superagent_*` 工具不存在 | 回到第 3 步看 `--dump-config` 里有没有 bundle 行；没有就重装，版本号写全。 |
| `the model provider rejected the API key` | key 不在启动宿主的那个进程里，或者 profile 用的不是这个变量名。 |
| `cost: not computed — no price configured for X` | 不是错误。把 `usage:` 行里的模型 id 抄进 `pricing` 就有了。 |

完整的错误表在 [README 的 Troubleshooting](../../README.md#troubleshooting)；
每个数字背后的验收记录在 [docs/DONE.md](../DONE.md)。
