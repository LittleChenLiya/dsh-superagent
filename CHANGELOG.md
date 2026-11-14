# Changelog

## 0.9.0 — unreleased

Hardening pass before the first publish. No behaviour change for the happy
path except the new spending caps and the cost line.

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
  checked before every child spawn. Hitting one ends the run `partial` and keeps
  the reports that finished.
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
  `detail: <untouched host message>`, covering 14 known failure shapes,
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
- A lock left by a dead process on this machine is broken immediately; a lock
  from another machine is broken after 10 minutes, because its pid cannot be
  checked.
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

### Install and first run

- Requirements corrected to what `dsh@0.2.2-rc.1` needs: Node `>=24.9.0`, and
  the default route's `DEEPSEEK_API_KEY` (not a DashScope key).
- Quickstart no longer tells people to `npm i -g dsh` (that is an unrelated
  package); it uses `npx @deepseek-ai/dsh@0.2.2-rc.1` and
  `dsh plugin --profile web add dsh-superagent`.
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

- 70 offline tests (`npm test`): fake store, fake child spawner, no network, no
  API key. Covers cross-process cancel, orphan reclamation in both local and
  shared modes, concurrent and cross-process resume, resume quotas and limit
  rebuilding, budgets with and without readable usage logs, pricing keys, a
  child that ignores abort, notify ordering, corrupted state, a missing state
  directory, retention, error text, usage-log reading, and a full plugin mount.
  Polling-based tests were rewritten around event gates; four consecutive full
  runs pass.
