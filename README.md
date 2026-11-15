# dsh-superagent

Long-horizon runs for [DeepSeek Harness](https://dshai.org): one goal in,
model-planned parallel subtasks, one merged report — and the run survives a host
restart.

A single agent loop is one context and one sequence. Goals that need several
independent lines of work stall in it, and a crash ends the turn with nothing to
resume. This plugin takes one goal, asks the model to split it into subtasks, runs
up to three child agents at a time, and merges their reports into one answer. Run
state and spend are written to disk, so after a host restart `superagent_status`
still finds the run and `superagent_resume` finishes only the unfinished part.
Every run has a hard call and token budget, prints the usage it measured, and
prints the cost once you give it a price for the route.

**Don't use it when** one model call can answer: you would only be paying for a
planner and an aggregator on top. It is also the wrong tool for work that must
finish inside a single turn, for a step that needs human approval in the middle,
for anything that needs nested delegation (child depth is capped at 1), and for
anyone who wants an in-host panel — this adds no UI, only six tools. Children run
with the host's credentials and filesystem; this is not a sandbox.

**Install and run.** Node `>= 24.9.0`, a tool-calling route, and that route's key
in the environment:

```bash
dsh plugin --profile web add @xiangyixie/dsh-superagent@0.10.0
```

Then ask the session for a run — a real call, not a sketch:

> Use superagent_start with goal "Explain the difference between process and thread in 300 words, with one concrete example" and wait_seconds 120.

The reply ends `completed` with the merged report, or with
`next: superagent_status run_id="..."` if the wait ran out. [Quickstart](#quickstart)
covers the path from an empty machine, including the reason not to install npm's
unrelated `dsh` package by name.

It adds no in-host UI and patches no host code: the six `superagent_*` tools are
the surface, plus two optional operator utilities (a terminal panel and an HTML
report) that read the same run files.

Personal project, not affiliated with DeepSeek or the harness maintainers. MIT
licensed, © 2026 Admire (LittleChenLiya); details in [License](#license).

## Requirements

- Node `>= 24.9.0`. DeepSeek Harness refuses to start below that, so this
  plugin does too.
- DeepSeek Harness `>= 0.2.2-rc.1 < 0.3.0` with the base bundle (the `tools`,
  `agents`, and `subagents` services).
- A model route that can call tools, and that route's API key in the
  environment. The default profile uses `deepseek-official` / `deepseek-flash`
  and reads `DEEPSEEK_API_KEY`.

## Quickstart

Five minutes, from nothing to a finished run. Every command below runs on a
clean machine.

### 0. Do not install `dsh` from npm by name

```bash
# WRONG: npm's `dsh` is unrelated ("a shell written in JavaScript")
npm i -g dsh

# RIGHT: run the DeepSeek Harness by its scoped package, pinned
npx @deepseek-ai/dsh@0.2.2-rc.1 --version
```

The rest of this page writes `dsh` for that command; if the binary is not on
your `PATH`, use `npx @deepseek-ai/dsh@0.2.2-rc.1` instead.

```bash
# 1. install the plugin into a profile (web, headless, ... whatever you run)
dsh plugin --profile web add @xiangyixie/dsh-superagent@0.10.0

# 2. confirm the bundle row exists in the merged config
dsh --profile web --dump-config
```

Name the version. Without one, pnpm's minimum release age policy skips releases
published in the last few hours and installs the newest older one, so a bare
`add` succeeds while giving you a version that is not current. If you would
rather track the newest release, add it to `minimumReleaseAgeExclude` in the
profile's `pnpm-workspace.yaml`; otherwise bump the number above. Check what
actually landed with:

```bash
npm ls --prefix <DSH_HOME>/profiles/web @xiangyixie/dsh-superagent
```

For an offline machine or a pinned artifact, install a packed tarball instead —
it is byte-identical to what the registry serves:

```bash
npm pack                                  # writes xiangyixie-dsh-superagent-<version>.tgz
dsh plugin --profile web add ./xiangyixie-dsh-superagent-<version>.tgz
```

If you are working on the plugin itself, install the checkout instead:

```bash
dsh plugin --profile web add file:/absolute/path/to/dsh-superagent
```

`file:` installs copy the package; re-run the `add` after changing the source,
or the profile keeps running the old copy.

Look for this block in the dump. If it is missing, the plugin is installed but
not mounted, and no `superagent_*` tool will exist:

```yaml
# == @xiangyixie/dsh-superagent
- id: superagent
  name: @xiangyixie/dsh-superagent
```

```bash
# 3. start the host with the key in the environment that starts it
export DEEPSEEK_API_KEY=sk-...          # PowerShell: $env:DEEPSEEK_API_KEY="sk-..."
dsh --profile web
```

The key must be the one for the route the profile actually uses. A profile
pointing at DashScope uses `DASHSCOPE_API_KEY`; a profile pointing at a
self-hosted gateway uses whatever that route names. See
[Other routes](#other-routes) if you want to add one.

In the session, ask for a run:

> Use superagent_start with goal "Explain the difference between process and thread in 300 words, with one concrete example" and wait_seconds 120.

Shape of the reply (numbers illustrative — a full transcript of a real run is
in [docs/e2e-2026-11-14.md](https://github.com/LittleChenLiya/dsh-superagent/blob/main/docs/e2e-2026-11-14.md)):

```
run 20261114T051233-a1b2 — completed
goal: Explain the difference between process and thread in 300 words, with one concrete example
plan: planned; subtasks 2/2 completed; max 3 in parallel; 2 attempt(s) each
elapsed: 18.4s
usage: input 4120 (+980 prompt tokens served from cache), output 455, calls 4 (deepseek-official/deepseek-flash: 4 call(s) 4120 in / 455 out)
cost: not computed — no price configured for deepseek-official/deepseek-flash; add a pricing entry in cordis.patch.yml to get an estimate
  [1] completed (attempts 1) Processes vs threads
  [2] completed (attempts 1) Concrete example

report:
...
```

There is no built-in price for the default DeepSeek route; see
[Spending limits and prices](#spending-limits-and-prices) to add one, after
which the next run (or a resume of this one) prints `cost: ...`. `cost` is
computed when a run settles, so an already-finished run keeps the "not
computed" line. `usage: not recorded` only appears on a finished run whose
child logs cannot be read at all — see [Troubleshooting](#troubleshooting).

If `wait_seconds` runs out before the run finishes, the reply ends with
`next: superagent_status run_id="..." wait_seconds=120`. Call it again; the run
keeps going either way.

To check recovery without a real crash: kill the host while a run is active,
start it again, then `superagent_status` shows `interrupted` and
`superagent_resume` finishes it. A run is only `interrupted` when no live
process owns it: while the original host is still running, its run is left
alone and the next mount reports it as active, not as interrupted.

Two shutdown paths behave differently, and both are covered by the E2E record:

- **Hard kill (or crash).** The heartbeat is a few seconds old, but on the
  machine that wrote the run the dead pid is checked first, so the next mount
  reclaims it immediately and prints
  `reclaimed: owner pid … is not running and this state directory is local`.
  A shared state directory written by another machine trusts the heartbeat
  instead, so reclamation there waits up to 90 s.
- **Graceful shutdown.** If the host disappears while a run is in flight (for
  example a one-shot headless turn that ends after `wait_seconds: 0`), the
  plugin notices that the `subagents` service is gone, leaves the unfinished
  subtasks `pending`, and settles the run as `interrupted` with
  `note: the host shut down while this run was active`. No attempts are burned
  on a service that cannot answer. In that case the host process itself may
  linger until a child that ignores abort exits; that wait is the host's, not
  the plugin's.

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
| `childPreset` | none | Agent preset for child agents. A preset owns the child's tool set; this host has no per-run tool filter. |
| `maxSubagentDepth` | `1` | How deep children may delegate. `1` forbids grandchildren; `provider-managed` leaves it to the backend. |
| `maxSubtasks` | `8` | Cap on planned subtasks. A tool argument can only lower it, never raise it; hard max 16. |
| `maxParallel` | `3` | Subtasks executing at once. A tool argument can only lower it; hard max 8. |
| `maxActiveRuns` | `2` | Active runs per state directory, across profiles and hosts that share it; further `superagent_start` calls are rejected. `superagent_resume` is not counted and works when the cap is full, because it only finishes work that already exists. |
| `attempts` | `2` | Attempts per subtask before it is marked failed. A failure that looks transient (quota, rate limit, timeout, 5xx) waits 2s, then 4s, then 8s before the next attempt. |
| `deadlineMinutes` | `120` | Wall-clock budget; on expiry the run ends `partial` or `failed`. |
| `maxModelCallsPerRun` | `80` | Hard cap on child model calls per run; `0` disables. |
| `maxTokensPerRun` | `2000000` | Hard cap on prompt + completion tokens per run; `0` disables. |
| `pricing` | empty | Per-1M-token prices, keyed exactly as the usage log names the model (`provider/model`). Nothing is priced out of the box. |
| `resultCapBytes` | `32768` | Bytes kept per subtask report. |
| `notifyOnComplete` | `true` | Master switch for proactive messages. Off means the plugin never wakes the session. |
| `maxNotificationsPerHour` | `3` | Proactive messages allowed per hour. Runs above the cap are folded into one summary; `0` disables the cap. |
| `notifyRetries` | `2` | Extra delivery attempts when the host refuses a wake-up; messages for one session are delivered in order. |
| `notifyRetryDelayMs` | `2000` | First delay between those attempts; it doubles per attempt, capped at 60s. |
| `autoResumeRounds` | `1` | Extra rounds that retry subtasks which failed in a way that looks transient, before the failure is reported; `0` disables. |
| `childModelFallback` | none | Model used on such a retry (quota, rate limit, timeout). Unset keeps the configured route. |
| `memory` | `true` | Cross-run notebook. See [Cross-run memory](#cross-run-memory). |
| `memoryScope` | `default` | Notebook file per scope, so unrelated projects can stay apart. Run notes are written here; `rules` and `profile` are read into every run. |
| `memoryMaxEntries` | `60` | Compaction threshold: a write that would exceed it compacts the notebook down to this many notes (400 lines / 128 KB are hard caps too). |
| `memoryMaxAgeDays` | `30` | Notes older than this are ignored, then compacted away. |
| `memoryDigestEntries` | `12` | Notes injected into a prompt. |
| `memoryDigestChars` | `1600` | Character budget for the note part of that prompt. |
| `keepRuns` | `0` | Delete terminal runs older than this many days at mount; `0` keeps everything. |
| `controlPort` | off | Loopback port for the embedding surface; `0` picks a free one. See [docs/embedding.md](https://github.com/LittleChenLiya/dsh-superagent/blob/main/docs/embedding.md). |

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
the environment variable named by the route; the plugin never stores a key. The
default profile's route is `deepseek-official` and reads `DEEPSEEK_API_KEY`.

### Other routes

The example above assumes a DashScope route is installed in the profile. It is
not part of the base bundle: the default profile has no `dashscope` provider and
`DASHSCOPE_API_KEY` alone will not create one. Add the route first (see the
harness docs for LLM plugins), then name it in `childProvider`.

### Child tools and recursion

`maxSubagentDepth: 1` is passed to the host as `maxDepth`, so a worker cannot
create its own children. This is enforced by the host, not by prompting, and a
provider that cannot enforce it makes `superagent_start` fail with an explicit
error instead of silently running unbounded.

There is **no** enforced tool allowlist on `dsh@0.2.2-rc.1`. The host's
subagent start request has no tool filter, and its own `subagent` tool rejects a
`toolFilter` config and points at agent presets. `childPreset` is therefore the
supported way to narrow a child's tools; without a dedicated preset, workers
inherit the session's tools. The `superagent_*` tools still exist in their tool
list, but `superagent_start`, `superagent_resume`, and `superagent_cancel`
refuse to run from a worker session; only the top-level agent manages runs.

### Spending limits and prices

Two hard budgets stop a pathological goal before it can spend quietly. Both are
checked before every child is spawned, so a retry loop cannot walk past them:

```yaml
- id: superagent
  config:
    maxModelCallsPerRun: 40
    maxTokensPerRun: 500000
    pricing:
      deepseek-official/deepseek-flash:
        input: 0.28          # price per 1M uncached prompt tokens (example)
        output: 0.42         # price per 1M completion tokens (example)
        cacheRead: 0.028     # optional; defaults to the input price
        currency: CNY
```

The pricing key is matched against the model id in the usage log, which is
`provider/model` — `superagent_status` prints it on the `usage:` line, so copy
the key from there. A key is matched exactly first, then by its bare model name,
so `qwen-flash` also prices `dashscope/qwen-flash` when there is no exact entry.
The plugin ships no price for any route, because a stale price is worse than a
missing one.

When a budget is hit, no new child starts and the abort controller stops the
child that is still running, so spend stops at the cap instead of draining one
more worker. Reports that already finished are still merged. The run ends
`partial` when at least one subtask completed and `failed` when none did (the
unfinished subtasks stay `pending`). `superagent_resume` rebuilds the limits
from the current config, keeps everything already spent, and continues from
there — that is how you raise a cap. On the real host, raising
`maxModelCallsPerRun` from 2 to 80 and resuming a run that stopped at 2/2
completed it without dropping the earlier spend.

A spawn counts as one model call even when the child's session log cannot be
read, so the call budget keeps working on a host whose log layout changed.
Token accounting still needs the log; when it is unavailable, the run prints a
`usage note:` saying the figures are a lower bound.

Costs are estimates from the table above, never from a built-in guess. A model
that is not listed is reported as `unpriced` and excluded from the total, so the
number you see is always a lower bound:

```
cost: at least ¥0.0041 (estimate; no price for haoduo/gpt-6.1-sol)
```

## Tools

- `superagent_start(goal, max_subtasks?, max_parallel?, deadline_minutes?, allow_duplicate?, wait_seconds?)`
  starts a run and returns immediately with a run id. Starting a goal that an
  active run in the same session already covers returns that run id marked
  `deduped: true` instead of paying for a second plan: the goal is compared after
  trimming, collapsing runs of whitespace, and ignoring case, and the check runs
  under a per-goal claim keyed in the state directory, so two processes that share
  it still start one run. The match is per session, because two sessions may
  legitimately ask for the same generic goal at once.
  `allow_duplicate: true` starts another one. A finished run never blocks the same
  goal from being started again. `wait_seconds` blocks for a terminal state and
  keeps the `deduped` marker in its result.
- `superagent_status(run_id, wait_seconds?)` returns status, milestones,
  per-subtask outcome, measured token usage, estimated cost, the report file
  path, and the final report.
- `superagent_list(limit?)` lists runs, newest first, plus the state directory's
  file count and size.
- `superagent_cancel(run_id)` stops the run, from any process; see below.
- `superagent_resume(run_id, wait_seconds?, force?)` continues an `interrupted`,
  `failed`, `partial`, or `cancelled` run; completed subtasks are kept. Workers
  are told what failed and to check what the earlier attempt already did. Only
  the session that started the run may resume it. A resume is not counted
  against `maxActiveRuns`, so it works when the cap is full; `force` is still
  accepted but no longer needed.
- `superagent_memory(action, key?, kind?, text?, scope?, limit?)` lists, adds,
  corrects, or forgets notebook notes. `set` with an existing key supersedes it;
  `forget` retracts it. `scope` addresses `rules` (project rules), `profile`
  (user preferences), or the run scope. The tool is additive: the five run tools
  keep their arguments and output.

## Progress, decisions, and artifacts

- **Milestones.** Every run records `plan_ready`, `running`, `aggregating`, and
  `settled` with a timestamp, shown in `superagent_status`. They never produce a
  proactive message; progress stays visible without becoming noisy.
- **Attention.** A worker or the aggregator may append one fenced `attention`
  block with a question that only the user can answer. It is stripped from the
  report, stored on the run as `attention.items`, shown as `needs your decision:`
  in status, and leads the notification when the run finishes. The question,
  options, and reason are collapsed to one line and capped at 500 / 200 / 300
  characters, so the block cannot inject a forged status or notification line.
  A block that is not valid JSON or has no question is kept in the report, and
  status prints `attention: <reason>` instead of hiding the request.
- **Report file.** A terminal run writes its report to
  `<stateDir>/reports/<runId>.md` with an atomic rename, so the outcome has a
  path that can be opened or attached. The directory carries a `.gitignore` with
  `*`, and the path is recorded in `run.artifacts` and shown in status.

## Cross-run memory

A run is isolated on purpose: planner and workers start empty. Without a
notebook, every run repeats work the last one already finished and rediscovers
the same traps. The plugin keeps two different things, and only one of them is
stored:

1. **What happened** is derived from the run store at planning time. The six
   most recent runs are rendered as one line each (date, status, completed
   subtasks, goal, run id). Nothing is copied, so it cannot drift from the run
   records.
2. **What was learned** is a small curated notebook: decisions, pitfalls, next
   steps, and which work was delegated. The aggregator returns it inside a
   fenced `memory` block that is removed from the report before the user sees it.
   A run that produces no block writes nothing; the plugin never invents a note.

**Storage.** `<stateDir>/memory/<scope>.jsonl`, one JSON object per line. A line
is `{v,id,ts,key,kind,text,runId,status}`; `key` is a short slug (`deploy-target`)
and `kind` is `decision`, `pitfall`, `next`, `dispatch`, or `note`. The directory
contains a `.gitignore` with `*`, so even a `stateDir` that points inside a
repository cannot commit the notebook. It is never listed in the package `files`
whitelist, so it never ships to npm.

**When it is written.** Once per run, at settle, only for a terminal run whose
report carried a block. A resume that settles the same run again is a no-op
because the store records the writing run id. A write failure is recorded on the
run (`memoryWrite.reason`) and never fails the run.

**When it is read.** Once at `superagent_start` (and again at `superagent_resume`,
since the aggregator will run again), before planning. The composed context is
stored on the run as `memory.digest`, injected into the planner and aggregator
prompts, and summarised in `superagent_status`.

**Layers.** Three scopes are read, in order: `rules` (project rules), `profile`
(user preferences), then `memoryScope` (what earlier runs learned). The first
two are curated with `superagent_memory` and are never written by a run, so a
rule cannot be overwritten by a model's observation. Each layer is labelled in
the prompt and bounded on its own; `memory.scopes` on the run lists what was
read.

**Size.** Each note is capped at 400 characters after redaction. A prompt sees at
most `memoryDigestEntries` notes inside `memoryDigestChars` characters, plus six
one-line run summaries, hard-capped at 2600 characters in total. The file is
compacted when a write would push it past `memoryMaxEntries` notes, 400 lines,
or 128 KB; compaction keeps the newest `memoryMaxEntries` notes.
Context cannot grow with the number of runs.

**Concurrency.** Within a process, writes to one scope are serialised. Across
processes, each batch is appended as one small `write` (no read-modify-write of
the whole file), compaction takes a lock file and replaces the file from a temp
file, and a truncated last line from a killed process is skipped. Two runs
finishing at once cannot overwrite each other's notes; a line may land in a
different order, and resolution is by timestamp, never by position.

**Correction.** A newer note with the same key supersedes the old one. An
explicit `forget` writes a tombstone. Notes older than `memoryMaxAgeDays` stop
being injected and are dropped at the next compaction. Every note is shown with
its age and the digest tells the model the notes may be stale and must be
verified, so a wrong conclusion can be refuted by a later run instead of
becoming a permanent bias.

**Privacy.** Notes are written outside the repository by default
(`$DSH_HOME/state/superagent/memory`). Before storage, the plugin redacts API-key
shapes (`sk-…`, `Bearer …`, `ghp_…`, `AKIA…`), long hex/base64 blobs, email
addresses, and absolute home paths; it collapses a note to one line and caps it.
The aggregator is instructed not to record secrets, customer data, or the report
itself. A `stateDir` inside the installed package disables memory rather than
risk shipping it. If you point `stateDir` at a repository, the nested
`.gitignore` still keeps the files out of a default `git add`.

## Watch and report

![Run report preview](https://github.com/LittleChenLiya/dsh-superagent/blob/main/docs/report-preview.jpg?raw=true)

_Top of a report rendered from 40 real host runs. The full page — timeline,
swimlanes, call and cost curves, failure annotations, run table — is
[docs/report-sample.html](https://github.com/LittleChenLiya/dsh-superagent/blob/main/docs/report-sample.html)._

Three operator utilities ship with the package, need no session, and add no
runtime dependency. `watch` and `report` read the same durable run files as the
tools; `doctor` inspects the install itself.

Run them from the installed copy inside the profile:

```bash
PKG="${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/@xiangyixie/dsh-superagent"
node "$PKG/bin/watch.js"                          # live panel, Ctrl-C to stop
node "$PKG/bin/report.js" --out report.html       # self-contained HTML page
```

If the profile's linker created bin links (npm does), the same commands are
`node_modules/.bin/dsh-superagent-watch`, `node_modules/.bin/dsh-superagent-report`,
and `node_modules/.bin/dsh-superagent-doctor`.

`watch` and `report` both accept `--state-dir <path>`; it defaults to
`$DSH_HOME/state/superagent`. Pass it when the plugin config sets a custom
`stateDir`.

**`watch`** draws one line per run — id, status, calls used against the cap,
elapsed time, what it is doing right now, and the parent session — in the
alternate screen, and restores the cursor on Ctrl-C, SIGTERM, or a closed pipe.
A status change repaints immediately; an idle panel reads one small file per
second. `--once` prints a single plain frame, which is what
[docs/e2e/transcripts/watch-panel.log](https://github.com/LittleChenLiya/dsh-superagent/blob/main/docs/e2e/transcripts/watch-panel.log)
captures from 40 real runs.

**`report`** renders recorded runs into one HTML file: inline CSS, inline SVG,
no script, no font, no image, no network. It has a timeline with each run's
start, end, and derived planning/work/merge phases; a swimlane chart whose lane
count is the peak concurrency; cumulative model-call and cost curves; explicit
failure, cancellation, and interruption annotations; and a run table.
[docs/report-sample.html](https://github.com/LittleChenLiya/dsh-superagent/blob/main/docs/report-sample.html)
is the 40-run report from the host e2e — open it directly, nothing is fetched —
and
[docs/e2e/transcripts/report-cli.log](https://github.com/LittleChenLiya/dsh-superagent/blob/main/docs/e2e/transcripts/report-cli.log)
records the command plus a zero-external-reference audit.

**`doctor`** answers "it installed, why does nothing work?" before the host
does. It reads only: no install, no mount, no edit to the profile. One block per
check — imported files against the `files` whitelist, declared files against
what is on disk, the installed copy against the published tarball for its
version, the profile's bundle registration, and the six registered tools — each
failure followed by the command that fixes it.

```bash
PKG="${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/@xiangyixie/dsh-superagent"
node "$PKG/bin/doctor.js" --profile web
node "$PKG/bin/doctor.js" --profile web --offline   # skip the registry hash check
```

Exit code is `0` when no check fails, `1` when one does, so it can gate a
deploy. `npm test` runs the same pack guard as
[`scripts/check-pack.mjs`](scripts/check-pack.mjs): every file reachable from
the entry points must appear in `npm pack --dry-run`, which is the check the
0.9.x release lacked.

None of these utilities is the install path: the plugin is installed with
`dsh plugin add`, never with `npm i -g`.

## Embedding over local HTTP

The tools require a session. If another UI or script must start and watch runs
without importing this package, set `controlPort`:

```yaml
- id: superagent
  config:
    controlPort: 0     # off by default; 0 = OS picks a free loopback port
```

The plugin then writes `<stateDir>/control.json` with the bound URL and a
per-process bearer token (mode `0600`) and serves `GET /`, `GET /health`,
`GET /runs`, `GET /runs/:id`, `POST /runs`, `POST /runs/:id/cancel`, and
`POST /runs/:id/resume` on `127.0.0.1` only. Every reply carries the same text
the tool would print (the route index and `/health` are the two exceptions:
they describe the socket, not a run). Every run goes through the same quota,
budgets, locks, and recovery as a tool-started run. `POST /runs` requires
`session_id` of a session that is live in that host — a run needs a real parent
agent for its children.

```bash
STATE="${DSH_HOME:-$HOME/.dsh}/state/superagent"
URL=$(node -e "console.log(require('$STATE/control.json').url)")
TOKEN=$(node -e "console.log(require('$STATE/control.json').token)")
curl -s -H "Authorization: Bearer $TOKEN" "$URL/runs"
```

The full contract — routes, error ids, security model, lifecycle, client
examples — is [docs/embedding.md](https://github.com/LittleChenLiya/dsh-superagent/blob/main/docs/embedding.md). It is opt-in, loopback
only, and there is no remote or unauthenticated mode.

## State and recovery

One file per run: `$DSH_HOME/state/superagent/runs/<runId>.json`, written with a
temp file plus rename, so a kill during a save cannot leave a half-written run.
Statuses: `queued`, `planning`, `running`, `aggregating`, `completed`,
`partial`, `failed`, `cancelled`, `interrupted`.

At mount the plugin marks a run as `interrupted` **only when it has no live
owner** (see below) and resets its in-flight subtasks to `pending`.
`superagent_resume` then re-runs only what did not finish. The planner's plan is
reused, so a resumed run does not pay for planning twice.

A state directory can be shared by two profiles or two machines. Recovery
therefore never decides from this process's memory alone: a run whose owner is
still alive — fresh heartbeat, live local pid, or a live process holding its
lock — is left untouched, cancel marker included. Two processes rewriting one
run would make the surviving child keep spending while the file says
`interrupted`, and a resume would then run the same subtasks twice.

Resuming is exclusive for the same reason. `superagent_resume` takes the same
serial gate as `superagent_start`, claims `<runId>.lock` (created atomically),
refuses a run that still has a live owner, and refuses a caller that is not the
session in `parentSessionId`. It does not count against `maxActiveRuns`: a
resume finishes work that already exists, so a full cap never blocks it. `force`
(tool) or `force` / `override_quota` (HTTP) is still accepted for compatibility
and changes nothing.

Three side files live next to the run:

| File | Meaning |
| --- | --- |
| `<runId>.cancel` | A cancel was requested by some process. The owner polls it once per second and stops its children. Removed when the run ends. |
| `<runId>.lock` | The process that is allowed to schedule this run. Created with `wx`, so exactly one process wins. A lock left by a dead local pid is broken immediately; a live local pid keeps it however long it has held it; a lock from another machine is broken once it is older than 10 minutes, since its pid cannot be checked. |
| `<runId>.json.corrupt-<ts>` | The state file was not valid JSON and was moved aside, not deleted. The run is skipped by `superagent_list` and reported by id with this path. |

If a run's file is damaged, nothing else breaks: other runs list normally, and
starting a new run works. Inspect the `.corrupt-` file, then delete it. A file
that cannot be read at all (permission, too many open files, disk full) is
reported as such instead of being shown as an unknown run.

### Orphaned runs and the active-run quota

A run counts against `maxActiveRuns` while its status is active. If the process
owning it disappears without a restart, the run would otherwise hold that slot
forever. Before every quota check the plugin looks for such runs and reclaims
them, with two different rules:

- **The state directory belongs to this machine** (`.owner` holds our hostname):
  a dead local pid is enough on its own — that is direct evidence the process is
  gone, so the next mount reclaims immediately regardless of the heartbeat. A
  live pid vetoes reclamation even with a stale heartbeat, because a wedged
  process may still resume.
- **The directory is shared, or its owner is unknown**: the pid may belong to
  another machine, so it is ignored and only the heartbeat decides; a run is
  reclaimed once its heartbeat is older than 90 seconds. This is the case for a
  state directory on a network share or a synced folder.

In both cases a lock held by a live local process also vetoes reclamation, and
mount-time recovery uses exactly the same rules — a run is never rewritten
while anybody can still be working on it.

Reclamation is never silent: the run becomes `interrupted`, its `reclaimed`
field records the exact basis (`pid 1234 is not running and its heartbeat
stopped at ...`, or `the state directory is shared with <host> ...`), the reason
is printed by `superagent_status`, and one line goes to the host log. The subtasks
that were mid-flight become `pending`, so `superagent_resume` continues the run.

The heartbeat is refreshed every 30 seconds by the owning process, so a healthy
run is never mistaken for an orphan.

### Talking to the user

The plugin is quiet unless the user must hear something. This is a rule in code,
not only in this document:

- **Allowed to interrupt:** a run finished and delivered a result, a run failed,
  or a run stopped half-way (`partial`, `interrupted`). A run the user cancelled
  is never announced — the caller already knows.
- **Never pushed:** progress, subtask start/finish, retries, and memory writes.
  They live in the run record, `superagent_status`, the watch panel, and the
  report page; the user can look, but nothing pops up.
- **Self-heal first:** each subtask gets `attempts` tries, and a failure that
  looks transient (quota, rate limit, timeout, 5xx) gets `autoResumeRounds`
  more rounds, optionally on `childModelFallback`. Only what still fails is
  reported, and the message says what was tried.
- **Bounded noise:** at most `maxNotificationsPerHour` proactive messages per
  hour. Runs above the cap are buffered and folded into the next message as one
  summary; `superagent_list` shows how many are waiting. If the message carrying
  a folded batch cannot be delivered, the batch stays buffered and rides the
  next one; it is dropped only after three failed deliveries.
- **Do not ask what is known:** the planner and aggregator receive the notebook
  and are told to use it instead of asking the user for facts it already holds.

`notifyOnComplete` is the master switch. Two cases already report instead of
notifying:

- a caller in the same host process was inside `superagent_status` and receives
  the terminal report itself (no message, to avoid duplicate noise). A poller in
  a *different* process does not suppress the message: it can time out just
  before the run ends, and then the only notification would be lost;
- the owning session is gone (headless users who closed it): the run records
  `notify.delivered = false` with the reason, `superagent_status` prints
  `notify: not delivered — ...`, and `superagent_list` marks the row
  `(result not delivered to the session)`. The report is always readable with
  `superagent_status`.

Waking the session is bounded (15 s), and the heartbeat keeps running until the
terminal state is written, so a slow wake-up cannot make another process treat a
live run as orphaned.

### Retention

Nothing is deleted by default. Set `keepRuns` to a number of days to delete
terminal runs older than that at mount; active runs are never touched, the
removed ids are logged, and the matching `reports/<runId>.md` artifact is
removed with its run. `superagent_list` prints the current file count and size,
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

Measured on the real host: with two workers sleeping inside a model call that
ignores abort, `superagent_cancel` returned `cancelled` in **1.99 s** and the
state file stopped accepting new spawns at that instant. The *host process*
still took 22.8 s to exit, because it waits for its own child sessions; that
wait is the host's teardown, outside the plugin's control. In an interactive
session you never notice it; in a one-shot headless turn it is why cancel
appears to "hang" until the ignored-abort child returns.

## Troubleshooting

| What you see | What it means | What to do |
| --- | --- | --- |
| `superagent_*` tools do not exist | The bundle row is not mounted, or the host refused to load the plugin. | Run `--dump-config` and check for the `@xiangyixie/dsh-superagent` block; reinstall with `dsh plugin --profile <p> add @xiangyixie/dsh-superagent@0.10.0` and read the host log for `[dsh-superagent]` lines. |
| `Cannot find module .../lib/control.js` (or `watch.js` / `report.js`) and the plugin never activates | The copy in that profile is incomplete — an `add` that was interrupted leaves a partial extraction. The published package is not the cause: every version ships all eleven `lib/` files. | Delete the plugin's directory under the profile's `node_modules` (scoped `@xiangyixie/dsh-superagent`, or unscoped `dsh-superagent` from an older tarball install) and run the same `add` command again, with the version number. Do not copy files in by hand. |
| `[error] the model provider rejected the API key` | The key env var is missing in the process that started the host. | Export `DEEPSEEK_API_KEY` (the default route) or the variable your route names, then restart `dsh`. |
| `MISSING_CREDENTIAL ... no API key for provider route "..."` | The profile's route has no credential in the environment. | Set the env var named for that route and restart. The error line names the route, so use that, not this page. |
| `[error] the subagent service is unavailable` | The profile has no `subagents` service, so the plugin has nothing to spawn. | Use a profile built on the base bundle (`web` or `headless` from the stock image), or add the subagent plugin to the profile. |
| `error: subagent provider "..." cannot enforce maxSubagentDepth` | The route's subagent backend cannot cap delegation. | Keep `provider: spawn`, or set `maxSubagentDepth: provider-managed` if you accept the backend's own limit. |
| `error: the Windows file sandbox could not start a child process` | Host sandbox launcher failure (`windows-acl-run: ...`), not your goal or key. The subtask is retried once. | Retry the run; if it repeats, restart the host, or disable the Windows ACL sandbox in the profile, then run the `diagnose-windows-sandbox-acl` skill. |
| `error: the run was not started because the active-run limit is already in use` | `maxActiveRuns` is full, including runs from another profile that shares the state directory. | Wait, cancel one, or raise `maxActiveRuns`. |
| `error: the run stopped because it reached its spending cap` | `maxModelCallsPerRun` or `maxTokensPerRun` was hit. | Read the partial report; raise the cap in the config, then `superagent_resume` continues with the new limits. |
| `usage: not recorded` | The run finished and no child session log could be read (moved `sessions` directory, or a run created before accounting). | Nothing to fix on old runs; new runs record usage. While a run is still active the line says accounting is pending instead. |
| `usage note: N child session log(s) could not be read` | Part of the usage was unreadable; the token figures are a lower bound. The call budget still counted those children. | Check that `$DSH_HOME/sessions` exists and is readable by the host process. |
| `cost: not computed — no price configured for X` | The model is not in the `pricing` table. | Add its per-1M prices under `pricing["provider/model"]`, copying the id from the `usage:` line. |
| `cost: at least ... (no price for X)` | Some children used an unpriced model. | Same as above; the figure covers only the priced part. |
| `[error] a saved run file is damaged` | A state file was truncated or invalid JSON. | The bytes were kept at `<runId>.json.corrupt-<ts>`; inspect, then delete. |
| `cancel requested ... not confirmed` | The owning process did not acknowledge within 5 s. | Check `superagent_status`; if the owner is gone, restart the host so recovery marks the run `cancelled`, then `superagent_resume` if you want it to continue. |
| `[error] ... still owned by a live process` | Another profile is running this run, so resuming here would duplicate the work. | Let it finish, or `superagent_cancel` it first. |
| `missing or wrong bearer token` (HTTP 401) | The embedder used a token from an earlier host start, or the wrong state directory's discovery file. | Read `token` from `<stateDir>/control.json` again; it is regenerated on every start. Read the file as UTF-8. |
| `the request did not name a live session` (HTTP 409) | `POST /runs` or `/resume` was called without a `session_id`, or the session closed. | Pass the id of a session open in that host process; run the start from the session that should own it. |
| `[dsh-superagent] control plane is not listening` in the host log | `controlPort` is already taken, the value is invalid, or the state directory is not writable. | Use `controlPort: 0`, free the port, fix the state directory, or remove the key; the tools keep working either way. |

A tool call that fails itself returns three lines: `[error]` a sentence, `hint:`
one next step, and `detail:` the untouched host message, so nothing is hidden.
A run that fails *after* it was accepted keeps its report and shows `error:`
(plus a `hint:` line when it is `failed`) in the run block instead.

## Known limits

- Children are not isolated by this plugin: they run with the host's
  credentials and filesystem, under whatever sandbox policy the host itself
  applies.
- A run lives inside the host process. Killing the process stops its children;
  the run becomes `interrupted` on the next mount.
- Cancelling from another process is cooperative: it relies on the owning
  process still running. A wedged process is only cleaned up at the next mount
  or when its heartbeat goes stale and the quota is reclaimed.
- Planning is one model call. If the reply has no parsable
  `{"subtasks":[...]}` object, the run degrades to a single subtask and is
  marked `plan.mode = "degraded"`.
- Aggregation is skipped for a single successful subtask (the report is that
  subtask's text under the goal heading) and falls back to a deterministic merge
  when the aggregator fails or the budget is exhausted.
- Retention is opt-in (`keepRuns`); by default state accumulates, at up to
  32 KB per subtask plus the report per run.
- The HTTP embedding surface is loopback-only, opt-in, and token-authenticated;
  it cannot be exposed remotely, and there is no MCP server. A local process
  running as the same user can read the token, which is the same trust boundary
  as writing run files.

## Naming

The package is published as `@xiangyixie/dsh-superagent` — npm already has a
`dsh-super-agent` that is too close to the unscoped name, so the scope keeps
the name instead of renaming the project. The tools are unchanged:
`superagent_*` (with `superagent_memory` added in 0.10, additively). The earlier working name was `dsh-longhaul` with `longhaul_*`
tools; nothing was ever published, so the old names do not exist anywhere and
there is no alias layer. If you find an old snippet that calls `longhaul_start`,
replace the prefix — the arguments are unchanged.

## Development

```bash
npm test        # node:test, fake store and fake child spawner, no network
npm pack        # inspect what would ship
```

What "ready to publish" means is written down as checkable rows in
[docs/DONE.md](https://github.com/LittleChenLiya/dsh-superagent/blob/main/docs/DONE.md); the real-host run that most of them point at is
[docs/e2e-2026-11-14.md](https://github.com/LittleChenLiya/dsh-superagent/blob/main/docs/e2e-2026-11-14.md).

Layout: `lib/index.js` (plugin, tool schemas, run formatting),
`lib/orchestrator.js` (ordering, retries, budgets, cancel, resume),
`lib/store.js` (atomic run files, cancel markers, quarantine),
`lib/errors.js` (readable error text), `lib/usage.js` (session log parsing),
`lib/control.js` (optional loopback HTTP surface).

## License

MIT. Copyright (c) 2026 Admire (LittleChenLiya); see [LICENSE](LICENSE).

The npm scope `@xiangyixie` and the GitHub account `LittleChenLiya` are the same
author.
