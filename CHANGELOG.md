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

### Tests

- 39 offline tests (`npm test`): fake store, fake child spawner, no network, no
  API key. Covers cross-process cancel, orphan reclamation in both local and
  shared modes, budgets, pricing, quarantine, retention, error text, and a full
  plugin mount.
