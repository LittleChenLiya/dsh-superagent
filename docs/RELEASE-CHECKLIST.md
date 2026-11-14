# Release checklist — dsh-superagent

Ordered by **external usability**: item 1 is what a stranger hits first, item 12
is housekeeping. "User" below means "someone who installed the plugin and did
not read the source". Effort is S (under an hour), M (half a day), L (a day or
more).

Status legend: `[ ]` not started, `[~]` in progress, `[x]` fixed and covered by
an offline test.

---

## P0 — blocks external use

### 1. Cross-process cancel only edits the state file `[x]`

- **Problem.** `superagent_cancel` called from a different host process rewrote
  `<runId>.json` to `cancelled`, but the process that owns the run kept
  planning, spawning workers, and spending tokens. The user saw "cancelled"
  while the run continued. The run's owner also overwrote the file on its next
  save, so the "cancelled" state disappeared.
- **Who is hit.** Anyone running the web and headless profiles at the same time,
  or cancelling from a second terminal. This is the first trap a real user
  falls into because the tool result looks successful.
- **Fix.** A `<runId>.cancel` marker file, written by any process and polled by
  the owner once per second; the marker aborts the owner's children. `cancel`
  from a non-owner writes the marker and waits up to 5 s for the owner to
  acknowledge, then reports honestly instead of claiming success. Recovery
  treats a marked run as `cancelled` instead of `interrupted`, and `resume`
  clears the marker. No socket, pipe, or host IPC involved.
- **Effort.** M.

### 2. No per-run spending cap `[x]`

- **Problem.** Only wall-clock (`deadlineMinutes`) and active-run count were
  bounded. A planner that produces 8 subtasks, each retried twice with a
  tool-using model, could quietly spend an unbounded amount of money.
- **Who is hit.** Every user, on the first pathological goal.
- **Fix.** Two hard budgets per run — `maxModelCallsPerRun` (default 80) and
  `maxTokensPerRun` (default 2,000,000) — checked before every child spawn.
  Exceeding a budget stops new spawns, ends the run `partial` with a readable
  error, and still merges the work that finished.
- **Effort.** S.

### 3. Usage and price reporting `[x]`

- **Problem.** Three separate defects: (a) runs recorded before usage reading
  worked print `usage: not recorded` with no explanation; (b) cached prompt
  tokens are reported next to uncached ones but never priced, so the cost is
  not reproducible; (c) there was no price table at all, so no run could say
  what it cost.
- **Who is hit.** Anyone deciding whether to trust the plugin with a real goal,
  and anyone comparing it with calling the model directly.
- **Fix.** `cost` is computed from an explicit per-model table
  (`pricing.<model>.{input,output,cacheRead,currency}`, per 1M tokens) and
  stored on the run. Missing models are reported as `unpriced` and excluded,
  never estimated. `formatRun` prints `cost: ¥0.0276 (estimate)` or
  `cost: not computed (no price for haoduo/gpt-6.1-sol)`, and explains why a
  run has no usage instead of printing two bare words.
- **Effort.** M.

### 4. Windows sandbox failure is opaque `[x]`

- **Problem.** When `@deepseek-ai/dsh-sandbox-windows-acl` fails before the
  command runs, it prints `windows-acl-run: --temp is not an existing
  directory` and exits 127. The plugin passed that string through verbatim, so
  the user saw a host-internal message and could not tell whether the goal, the
  API key, or the machine was at fault, nor whether a retry would help.
- **Who is hit.** Every Windows user who hits the intermittent ACL failure.
- **Fix.** Classify the message, explain it is a host sandbox launch failure
  (not the goal, not the key), state that the subtask is retried once, and give
  three concrete next steps (retry, restart the host, run the
  `diagnose-windows-sandbox-acl` skill). The run still reports `failed` for that
  subtask; nothing is faked.
- **Effort.** S.

### 5. Corrupt state and kill-during-write `[x]`

- **Problem.** A truncated or empty `<runId>.json` made `read` throw
  `Unexpected end of JSON input` out of every tool. `list` died as a whole, so
  one bad file hid every other run. A `.tmp` file left by a killed process sat
  in the runs directory forever.
- **Who is hit.** Anyone whose machine sleeps, whose antivirus locks a file, or
  who kills the host during a save.
- **Fix.** Unparsable files are moved to `<runId>.json.corrupt-<ts>` (evidence
  kept), skipped by `list`, and named with their quarantine path when the user
  asks for that run by id. Temp files older than 10 minutes and cancel markers
  whose run is already terminal are removed at mount. The behaviour is
  documented in the README.
- **Effort.** S.

---

## P1 — needed before it feels finished

### 6. Tool errors are raw host strings `[x]`

- **Problem.** Every tool returned `[error: ${error.message}]`, so users saw
  `Cannot read properties of undefined (reading 'maxDepth')`, bare `fetch
  failed`, or a stack-shaped message with no next step.
- **Who is hit.** Everyone who hits any failure.
- **Fix.** One classifier (`lib/errors.js`) maps the message to a plain
  sentence, a `hint:`, and the untouched `detail:` line. Covered: quota, unknown
  run, corrupt state, budget, Windows sandbox, auth (401/403), network,
  disk/permission, context length, and host API-shape errors. Subtask lines in a
  report use the one-sentence form.
- **Effort.** M.

### 7. README cannot be followed by a stranger `[x]`

- **Problem.** Install, config, and accounting were documented, but there was
  no end-to-end "do this, expect that" path, no troubleshooting table, and no
  pricing/budget example. The one known footgun (cancel across processes) was
  buried under "Known limits".
- **Who is hit.** Every new user, and every reviewer.
- **Fix.** Add a Quickstart with exact commands, expected output, and the
  five-minute verification; a troubleshooting table keyed by the error text the
  user actually sees; pricing and budget configuration examples; and a
  state/recovery section describing the quarantine files.
- **Effort.** S.

### 8. Package contents are unverified `[x]`

- **Problem.** `npm pack` was never inspected: a missing `lib/usage.js` or
  `cordis.patch.yml` would install cleanly and then fail on first use.
- **Who is hit.** Everyone installing from a tarball or a registry.
- **Fix.** Offline check of the tarball file list, then install that tarball
  into a throwaway profile and confirm `--dump-config` shows the row.
- **Effort.** S.

### 9. Offline test coverage for the fixes above `[x]`

- **Problem.** Cancellation, budgets, pricing, corruption, and error text had no
  tests; the regression that once turned a good run into `failed` (concurrent
  saves) was covered only by one Windows-specific case.
- **Who is hit.** Every future change.
- **Fix.** `node:test` cases with fake stores and fake child spawners only; no
  network, no API key, no real model.
- **Effort.** M.

---

## P2 — hardening after first external users

### 10. Orphaned runs can hold the quota `[x]`

- **Problem.** If the owning process dies without being restarted, its run stays
  `active` in the file and `maxActiveRuns` stays full. Only a new mount's
  recovery cleared it.
- **Who is hit.** Users who kill a host and immediately start another run in the
  same process, and anyone sharing a state directory between machines.
- **Fix (decided).** `.owner` records the hostname that created the state
  directory. When it matches this machine, a run is reclaimed only if its
  heartbeat is older than 90 s **and** its owner pid is gone; a live pid vetoes
  reclamation. When the directory is shared or the owner is unknown, the pid is
  ignored and the heartbeat alone decides. Every reclamation writes
  `run.reclaimed.basis`, prints it in `superagent_status`, and logs one line.
  Heartbeat is refreshed every 30 s by the owning process.
- **Effort.** M.

### 11. Notification edge cases `[x]`

- **Problem.** If the owning session was gone, the completion message was
  dropped with a log line only. If the user was polling, the message was
  suppressed — correct, but invisible.
- **Who is hit.** Headless users who close the session before the run ends.
- **Fix.** The outcome is stored on the run (`notify.delivered`,
  `notify.reason`). A failure is shown by `superagent_status`
  (`notify: not delivered — ...`) and marked in `superagent_list`
  (`(result not delivered to the session)`). The polling rule is documented.
- **Effort.** S.

### 12. State growth `[x]`

- **Problem.** Each run keeps up to 32 KB per subtask plus the report; nothing
  pruned old runs.
- **Who is hit.** Long-running installs.
- **Fix.** Opt-in `keepRuns` (days) deletes terminal runs older than the window
  at mount, never active ones, and logs the removed ids. `superagent_list` prints
  the state directory's file count and size, plus the number of quarantined
  files.
- **Effort.** S.

### 13. Publish metadata `[x]`

- **Problem.** No `repository`, no `homepage`, no `CHANGELOG`, version still
  `0.1.0`, and the npm name was never checked for availability.
- **Who is hit.** Reviewers and packagers.
- **Fix.** Public repository at
  <https://github.com/LittleChenLiya/dsh-superagent>; `repository`, `homepage`, and
  `bugs` point at it; version `0.9.0`; `CHANGELOG.md` ships in the package.
  `exports` advertises the plugin entry point plus `cordis.patch.yml` (the
  bundle patch the host resolves by path); internals stay private because the
  internal subpaths ship without types. `npm pack --dry-run` prints a
  15-file, 72.9 kB tarball (239.0 kB unpacked) with no runtime dependencies.
  Name availability on the registry is still unverified because
  that needs a registry lookup at publish time.
- **Effort.** S.

---

## P0 — found by the independent pre-release review

### 14. Mount and resume could run the same run twice `[x]`

- **Problem.** (B1) `recover()` rewrote *any* active run, so starting a second
  profile on a shared state directory marked the first profile's live run
  `interrupted`; the live process then saved `running` again, and a resume ran
  the same subtasks. (B2) `superagent_resume` checked only this process's
  memory, skipped the start gate, and skipped the `maxActiveRuns` quota, so two
  resumes (in one process or across two) could both schedule the same run.
- **Fix.** One `ownership()` verdict is shared by `recover`, `sweepOrphans`, and
  `resume`: a fresh heartbeat, a live local pid, or a live process holding the
  lock means "leave it alone". Resume takes the same serial gate as start,
  claims `<runId>.lock` with `wx`, re-reads under the lock, refuses a live
  owner, and applies the quota. A remote lock older than 10 minutes is treated
  as dead. Covered by two orchestrators on one real state directory.
- **Effort.** M.

### 15. Spending caps could be bypassed, and cancel could hang `[x]`

- **Problem.** (B3) `spentCalls` was summed from `subtask.usage`, which only
  exists after a child finishes *and* its session log is readable; with an
  unreadable log the counters stayed at 0, so `maxModelCallsPerRun: 2` still
  produced four workers and an aggregator. (I1) a child that ignores abort could
  hold `cancel` forever. (I2) the terminal status was saved before the notify
  outcome, leaving a window with no notify row. (I3) a resumed run kept
  `notified: true`, so it never woke the session again.
- **Fix.** A spawn is counted and saved *before* the child exists, so it is
  always in the budget even with no readable usage; finished attempts and
  heartbeats replace the per-child snapshot when the log is readable. Spawning
  is abortable and a late child is disposed. The terminal status and its notify
  outcome land in one save; waking the session is bounded. Resume resets
  `notified`/`notify`/`cancelPending` and rebuilds `limits` from the current
  config.
- **Effort.** M.

### 16. A stranger following the README usually failed `[x]`

- **Problem.** (A) The README assumed the author's machine: no DSH install step
  (`npm i -g dsh` installs an unrelated package), a `file:` install, the wrong
  key name (`DASHSCOPE_API_KEY` for a `deepseek-official` route), and Node
  `>=22.19` where the host requires `>=24.9`. (B) pricing keys never matched the
  `provider/model` ids in the usage log. (C) the README promised that raising a
  cap and resuming worked, but limits were frozen at start. (D) a broken
  stateDir was swallowed and shown as "no runs recorded". (E)
  `MISSING_CREDENTIAL` and unknown model ids were unclassified. (F) new runs
  showed alarming `usage: not recorded`, `interrupted` had no next step, and
  cancelled subtasks looked failed. (G) a host without `subagents` silently
  mounted nothing. (H) `exports` exposed subpaths without types.
- **Fix.** README rewritten around `npx @deepseek-ai/dsh@0.2.2-rc.1`,
  `dsh plugin --profile web add dsh-superagent`, `DEEPSEEK_API_KEY`, Node
  `>=24.9`, and real expected output. Pricing accepts the exact `provider/model`
  key and falls back to the bare model name. Resume rebuilds limits. State
  initialization failures are reported by every tool. New error classes and
  hints. `usage: accounting pending` while active, a `next:` line for
  `interrupted`, `skipped`/`cancelled` subtask wording, and split elapsed time.
  `subagents` is optional and `start` explains the missing service. `exports`
  reduced to `.` and `./package.json`.
- **Effort.** M.

### 17. The first real-host run found four defects `[x]`

- **Problem.** Against `dsh@0.2.2-rc.1` with a keyless stub route: (a) a
  graceful host shutdown turned every in-flight child into "service
  unavailable", burned both attempts and settled the run `failed`, so a
  one-shot headless turn destroyed resumable work; (b) `ownership()` trusted a
  fresh heartbeat before the pid, so a `kill -9` left the run `running` for
  90 s on the machine that could prove the pid was dead; (c) a reclaimed run
  printed "cost: not computed" despite having a readable usage snapshot;
  (d) `subtask.usage` was usually `null` because the read at completion races
  the log flush.
- **Who is hit.** Every headless user whose turn ends while a run is active,
  and anyone who kills the host and expects `resume` to work.
- **Fix.** `subagent-unavailable` is recognised as the host going away: no
  attempts burned, subtasks left `pending`, run settled `interrupted` with a
  note. A dead pid on a locally written run outranks the heartbeat; a shared
  directory still trusts the heartbeat. Reclaim republishes usage and cost.
  Settle writes the final per-child usage back onto each subtask. Transcripts
  and numbers in [e2e-2026-11-14.md](e2e-2026-11-14.md).
- **Effort.** M.

### 18. Other UIs and plugins cannot use it as an engine `[x]`

- **Problem.** The only calling surface is the five host tools, which exist
  inside a DSH session. A panel, a scheduler, or another plugin cannot list or
  start runs without importing `lib/` and fabricating a Cordis context.
- **Fix.** Opt-in local HTTP control plane (`lib/control.js`, `controlPort`):
  `GET /health`, `GET /runs`, `GET /runs/:id`, `POST /runs`,
  `POST /runs/:id/cancel`, `POST /runs/:id/resume`, bound to `127.0.0.1` with a
  per-process bearer token in `<stateDir>/control.json` (0600), a `Host` check
  against DNS rebinding, no CORS, and bounded bodies/timeouts. Every route runs
  through the same orchestrator, and replies carry the tool's exact `text`.
  `POST /runs` requires a live `session_id`; there is no synthetic parent.
  Contract in [embedding.md](embedding.md), verified on real `dsh@0.2.2-rc.1`
  with 17/17 checks in
  [transcripts/control-plane.log](e2e/transcripts/control-plane.log), plus 7
  offline transport tests and one plugin-level end-to-end test. A second real
  pass with two hosts on one state directory verified cross-process cancel in
  [transcripts/cross-cancel.log](e2e/transcripts/cross-cancel.log) (9/9 checks).
- **Effort.** M.
