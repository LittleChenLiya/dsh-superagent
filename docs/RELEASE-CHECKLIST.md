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
  `bugs` point at it; version `0.9.0`; `CHANGELOG.md` ships in the package;
  `./errors` export added. `npm publish --dry-run` prints a 9-file, 29.3 kB
  tarball. Name availability on the registry is still unverified because that
  needs a registry lookup at publish time.
- **Effort.** S.
