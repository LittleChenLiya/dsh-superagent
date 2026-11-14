# dsh-superagent

Long-horizon autonomous runs for [DeepSeek Harness](https://dshai.org).

One goal goes in. A planner splits it into independent subtasks, the subtasks
run in parallel child agents, and an aggregator merges their reports into one
answer. Runs are persisted to disk, so a host restart does not lose them:
`superagent_status` reports them and `superagent_resume` continues them.

Registered tools: `superagent_start`, `superagent_status`, `superagent_list`,
`superagent_cancel`, `superagent_resume`. No panel, no host patch, no runtime
dependencies.

### Naming

The package and its five tools share one prefix on purpose: `dsh-superagent`
registers `superagent_*`. The earlier working name was `dsh-longhaul` with
`longhaul_*` tools; nothing was ever published, so the old names do not exist
anywhere and there is no alias layer. If you find an old snippet that calls
`longhaul_start`, replace the prefix — the arguments are unchanged.

## Requirements

- DeepSeek Harness `>= 0.2.2-rc.1 < 0.3.0` with the base bundle (`tools`,
  `agents`, `subagents` services).
- Node `>= 22.19.0` (uses `zlib.zstdDecompressSync` for token accounting).
- A model route that can call tools, and its API key in the environment.

## Quickstart

Five minutes, from nothing to a finished run.

```bash
# 1. install into a profile (use any profile you already run: web, headless, ...)
dsh plugin --profile web add file:/absolute/path/to/dsh-superagent

# 2. confirm the bundle row exists in the merged config
dsh --profile web --dump-config
```

Look for this block in the output. If it is missing, the plugin is installed but
not mounted, and no `superagent_*` tool will exist:

```yaml
# == dsh-superagent
- id: superagent
  name: dsh-superagent
```

```bash
# 3. start the host with the key in the environment that starts it
export DASHSCOPE_API_KEY=sk-...          # PowerShell: $env:DASHSCOPE_API_KEY="sk-..."
dsh --profile web
```

In the session, ask for a run:

> Use superagent_start with goal "Explain the difference between process and thread in 300 words, with one concrete example" and wait_seconds 120.

Expected shape of the reply:

```
run 20261114T051233-a1b2 — completed
goal: Explain the difference between process and thread in 300 words, with one concrete example
plan: planned; subtasks 2/2 completed; max 3 in parallel; 2 attempt(s) each
elapsed: 18.4s
usage: input 4120 (+980 prompt tokens served from cache), output 455, calls 4 (qwen-flash: 4 call(s) 4120 in / 455 out)
cost: ¥0.0014 (estimate; all models priced)
  [1] completed (attempts 1) Processes vs threads
  [2] completed (attempts 1) Concrete example

report:
...
```

If you see `usage: not recorded` or `cost: not computed`, the run still worked;
those two lines are covered in [Troubleshooting](#troubleshooting).

To check recovery without a real crash: kill the host while a run is active,
start it again, then `superagent_status` shows `interrupted` and `superagent_resume`
finishes it.

## Configuration

Row config in `<profile>/cordis.patch.yml`:

```yaml
- id: superagent
  config:
    maxSubtasks: 8
    maxParallel: 3
    maxActiveRuns: 2
```

| Key | Default | Meaning |
| --- | --- | --- |
| `stateDir` | `$DSH_HOME/state/superagent` | Run state root. |
| `provider` | `spawn` | Subagent backend used for planner, workers, aggregator. |
| `childProvider` | parent's | Optional provider route override for child agents. |
| `childModel` | parent's | Optional model override for child agents. |
| `maxSubtasks` | `8` | Cap on planned subtasks (tool can lower it, hard max 16). |
| `maxParallel` | `3` | Subtasks executing at once (hard max 8). |
| `maxActiveRuns` | `2` | Active runs per host; further `superagent_start` calls are rejected. |
| `attempts` | `2` | Attempts per subtask before it is marked failed. |
| `deadlineMinutes` | `120` | Wall-clock budget; on expiry the run ends `partial` or `failed`. |
| `maxModelCallsPerRun` | `80` | Hard cap on child model calls per run; `0` disables. |
| `maxTokensPerRun` | `2000000` | Hard cap on prompt + completion tokens per run; `0` disables. |
| `pricing` | `qwen-flash` list price | Per-1M-token prices used for the cost line. |
| `resultCapBytes` | `32768` | Bytes kept per subtask report. |
| `notifyOnComplete` | `true` | Wake the owning session once when a run finishes while nobody is polling. |
| `keepRuns` | `0` | Delete terminal runs older than this many days at mount; `0` keeps everything. |

### Switching models

Model choice is configuration, not code. By default child agents inherit the
session's model from the profile's `agent-default-model`. To pin children to a
specific route, set both keys and restart the host:

```yaml
- id: superagent
  config:
    childProvider: dashscope
    childModel: qwen-flash
```

Nothing about a model id is compiled into the plugin. API keys are read from
the environment variable named by the route (`DASHSCOPE_API_KEY`,
`HAODUO_API_KEY`); the plugin never stores a key.

### Spending limits and prices

Two hard budgets stop a pathological goal before it can spend quietly. Both are
checked before every child is spawned, so a retry loop cannot walk past them:

```yaml
- id: superagent
  config:
    maxModelCallsPerRun: 40
    maxTokensPerRun: 500000
    pricing:
      qwen-flash:
        input: 0.15          # price per 1M uncached prompt tokens
        output: 1.5          # price per 1M completion tokens
        cacheRead: 0.03      # optional; defaults to the input price
        currency: CNY
```

When a budget is hit, no new child starts, the run ends `partial` with
`error: ... budget reached ...`, and the reports that already finished are still
merged. `superagent_resume` continues from there after you raise the cap.

Costs are estimates from this table, never from a built-in guess. A model that
is not listed is reported as `unpriced` and excluded from the total, so the
number you see is always a lower bound:

```
cost: at least ¥0.0041 (estimate; no price for haoduo/gpt-6.1-sol)
```

The default table contains only `qwen-flash` (¥0.15 / ¥1.5 per 1M, DashScope
list price). Check the provider's current price page before trusting it, and
override it in the config above.

## Tools

- `superagent_start(goal, max_subtasks?, max_parallel?, deadline_minutes?, wait_seconds?)`
  starts a run and returns immediately with a run id. `wait_seconds` blocks for
  a terminal state instead.
- `superagent_status(run_id, wait_seconds?)` returns status, per-subtask outcome,
  measured token usage, estimated cost, and the final report.
- `superagent_list(limit?)` lists runs, newest first, plus the state directory's
  file count and size.
- `superagent_cancel(run_id)` stops the run, from any process; see below.
- `superagent_resume(run_id, wait_seconds?)` continues an `interrupted`, `failed`,
  `partial`, or `cancelled` run; completed subtasks are kept.

## State and recovery

One file per run: `$DSH_HOME/state/superagent/runs/<runId>.json`, written with a
temp file plus rename, so a kill during a save cannot leave a half-written run.
Statuses: `queued`, `planning`, `running`, `aggregating`, `completed`,
`partial`, `failed`, `cancelled`, `interrupted`.

At mount the plugin rewrites any run still marked active by a previous process
to `interrupted` and resets its in-flight subtasks to `pending`. `superagent_resume`
then re-runs only what did not finish. The planner's plan is reused, so a
resumed run does not pay for planning twice.

Two side files live next to the run:

| File | Meaning |
| --- | --- |
| `<runId>.cancel` | A cancel was requested by some process. The owner polls it once per second and stops its children. Removed when the run ends. |
| `<runId>.json.corrupt-<ts>` | The state file was not valid JSON and was moved aside, not deleted. The run is skipped by `superagent_list` and reported by id with this path. |

If a run's file is damaged, nothing else breaks: other runs list normally, and
starting a new run works. Inspect the `.corrupt-` file, then delete it.

### Orphaned runs and the active-run quota

A run counts against `maxActiveRuns` while its status is active. If the process
owning it disappears without a restart, the run would otherwise hold that slot
forever. Before every quota check the plugin looks for such runs and reclaims
them, with two different rules:

- **The state directory belongs to this machine** (`.owner` holds our hostname):
  a run is reclaimed when its heartbeat is older than 90 seconds **and** its
  recorded owner pid is no longer running. A live pid vetoes reclamation even
  with a stale heartbeat, because a wedged process may still resume.
- **The directory is shared, or its owner is unknown**: the pid may belong to
  another machine, so it is ignored and only the heartbeat decides. This is the
  case for a state directory on a network share or a synced folder.

Reclamation is never silent: the run becomes `interrupted`, its `reclaimed`
field records the exact basis (`pid 1234 is not running and its heartbeat
stopped at ...`, or `the state directory is shared with <host> ...`), the reason
is printed by `superagent_status`, and one line goes to the host log. The subtasks
that were mid-flight become `pending`, so `superagent_resume` continues the run.

The heartbeat is refreshed every 30 seconds by the owning process, so a healthy
run is never mistaken for an orphan.

### Notification boundaries

`notifyOnComplete` writes one message back into the owning session when a run
finishes **and nobody is polling**. Two cases report instead of notifying:

- a caller was inside `superagent_status` (no message, to avoid duplicate noise);
- the owning session is gone (headless users who closed it): the run records
  `notify.delivered = false` with the reason, `superagent_status` prints
  `notify: not delivered — ...`, and `superagent_list` marks the row
  `(result not delivered to the session)`. The report is always readable with
  `superagent_status`.

### Retention

Nothing is deleted by default. Set `keepRuns` to a number of days to delete
terminal runs older than that at mount; active runs are never touched, and the
removed ids are logged. `superagent_list` prints the current file count and size,
so growth is visible before it becomes a problem.

## Cancelling from another process

`superagent_cancel` works even when the run was started by a different host
process (web and headless running side by side, or a second terminal). The
crossing point is the `.cancel` marker file, not shared memory:

1. the caller writes `<runId>.cancel`;
2. the owning process notices within a second, aborts its children' signal,
   disposes their activations, and writes `cancelled`;
3. the caller waits up to 5 seconds for that, then reports what happened.

If the owner does not answer in time, the reply says
`cancel requested ... not confirmed` instead of `cancelled`. That means the
owning process is gone or wedged; the marker stays on disk, and the next mount
converts the run to `cancelled` during recovery. No socket, pipe, or Windows
named pipe is involved, so this works the same on every platform and across a
shared state directory.

## Troubleshooting

| What you see | What it means | What to do |
| --- | --- | --- |
| `superagent_*` tools do not exist | The bundle row is not mounted. | Run `--dump-config` and check for the `dsh-superagent` block; reinstall with `dsh plugin --profile <p> add file:<abs path>`. |
| `[error] the model provider rejected the API key` | The key env var is missing in the process that started the host. | Export `DASHSCOPE_API_KEY` / `HAODUO_API_KEY` before starting `dsh`, then restart. |
| `[error] the Windows file sandbox could not start a child process` | Host sandbox launcher failure (`windows-acl-run: ...`), not your goal or key. The subtask is retried once. | Retry the run; if it repeats, restart the host, or disable the Windows ACL sandbox in the profile, then run the `diagnose-windows-sandbox-acl` skill. |
| `[error] the run was not started because the active-run limit is already in use` | `maxActiveRuns` is full. | Wait, cancel one, or raise `maxActiveRuns`. |
| `[error] the run stopped because it reached its spending cap` | `maxModelCallsPerRun` or `maxTokensPerRun` was hit. | Read the partial report; raise the cap only if the spend is expected. |
| `usage: not recorded` | No child session log was readable (runs created before accounting, or a moved `sessions` directory). | Nothing to fix on old runs; new runs record usage. |
| `cost: not computed — no price configured for X` | The model is not in the `pricing` table. | Add its per-1M prices under `pricing.<model>`. |
| `cost: at least ... (no price for X)` | Some children used an unpriced model. | Same as above; the figure covers only the priced part. |
| `[error] a saved run file is damaged` | A state file was truncated or invalid JSON. | The bytes were kept at `<runId>.json.corrupt-<ts>`; inspect, then delete. |
| `cancel requested ... not confirmed` | The owning process did not acknowledge within 5 s. | Check `superagent_status`; if the owner is gone, restart the host so recovery marks the run `cancelled`, then `superagent_resume` if you want it to continue. |

Every tool error has three lines: `[error]` a sentence, `hint:` one next step,
and `detail:` the untouched host message, so nothing is hidden.

## Known limits

- A run lives inside the host process. Killing the process stops its children;
  the run becomes `interrupted` on the next mount.
- Cancelling from another process is cooperative: it relies on the owning
  process still running. A wedged process is only cleaned up at the next mount
  or when its heartbeat goes stale and the quota is reclaimed.
- Planning is one model call. If the reply has no parsable
  `{"subtasks":[...]}` object, the run degrades to a single subtask and is
  marked `plan.mode = "degraded"`.
- Aggregation is skipped for a single successful subtask (the report is that
  subtask's text) and falls back to a deterministic merge when the aggregator
  fails or the budget is exhausted.
- Retention is opt-in (`keepRuns`); by default state accumulates, at up to
  32 KB per subtask plus the report per run.

## Development

```bash
npm test        # node:test, fake store and fake child spawner, no network
npm pack        # inspect what would ship
```

Layout: `lib/index.js` (plugin, tool schemas, run formatting),
`lib/orchestrator.js` (ordering, retries, budgets, cancel, resume),
`lib/store.js` (atomic run files, cancel markers, quarantine),
`lib/errors.js` (readable error text), `lib/usage.js` (session log parsing).

## License

MIT
