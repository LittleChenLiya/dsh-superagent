# Progress

Working notes for the road to a publishable release. The checklist in
[RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md) tracks gates; this file tracks
what was done, the evidence, and what is deliberately left.

## 2026-11-14 — round 1: the three blockers from the adversarial review

An independent reviewer cloned `07def5a`, reproduced three blocking defects and
three important ones. All are fixed here; the fixes are in
`lib/orchestrator.js`, `lib/store.js`, `lib/index.js`.

### B1 — a second process could rewrite a run that was still executing

`recover()` used to rewrite every run in an active status that this process did
not have in memory. Two profiles sharing one state directory (the setup the
README recommends) therefore fought over one file: profile A kept running
children and saving `running`, profile B rewrote `interrupted`, and a resume
would then run every unfinished subtask a second time.

Fix: `ownership()` is now the single liveness decision used by recovery, orphan
sweeping, and resume. A run is live when its heartbeat is younger than 90 s, or
— on a state directory that belongs to this machine — when its owner pid still
exists, or when a live pid holds the run lock. Recovery leaves a live run
completely alone, including its cancel marker, so the owner still sees it.

### B2 — resume had no mutex and no quota

`resume()` only checked this process's in-memory map, bypassed the serial start
gate, and never called `activeCount()`. Two resumes of one run, a cross-process
resume, or a resume on top of a full quota all produced a second copy of the
same work.

Fix: resume runs inside the same gate as `start()`, claims the new per-run lock
(`<runId>.lock`, created with `wx`), re-reads the run under that lock, rejects a
run that still has a live owner, and checks the active-run quota before
scheduling.

### B3 — the spending caps were silently dead when usage could not be read

`spentCalls`/`spentTokens` only summed `subtask.usage`, which was written only
when a child finished *and* its session log could be parsed. Any change in the
log layout made the counters zero forever: `maxModelCallsPerRun: 2` happily
started four workers and an aggregator.

Fix: three layers of counting.
1. A spawn is counted in `run.counters.spawns` and persisted *before* the child
   exists; `spentCalls` takes `max(measured, spawns)`, so the call budget cannot
   go blind.
2. Usage is read at child completion, at failure (failed attempts used to be
   free), and on every heartbeat while the child is alive, which caps a runaway
   single child too.
3. `run.usageByChild` stores the latest cumulative snapshot per child, so a
   resume keeps the spend of earlier segments.

### I1 — cancel could hang forever

`cancel()` awaited `Promise.all(dispose)` with no timeout, and subtasks awaited
`handle.result` with no abort. A child that ignores its abort signal held the
call open indefinitely.

Fix: every dispose races a 1.5 s timer, results are awaited through
`abortable()`, and a subtask interrupted by cancel/deadline is left `pending`
(resumable) rather than `failed`.

### I2 — the terminal state and the notify outcome were two writes

The run was saved as `completed` and then saved again with the notify result, so
a reader could see a finished run with no notify line. The flaky test was
polling for the second write.

Fix: `settle()` computes usage, cost, status, and the notify outcome in memory
and writes exactly once. Tests use `orchestrator.idle()` instead of sleeping.

### I3 — a resumed run never woke its session again

`resume()` kept `notified = true`, so the second completion was silent, and
`notifyFailed()` filtered the `skipped:` reason out of the UI.

Fix: resume clears `notified`/`notify`, so the second completion notifies again.

### Smaller fixes in the same pass

- `capText` no longer cuts a multi-byte character in half (no more U+FFFD).
- Removed the no-op `run.parentSessionId = run.parentSessionId`.
- `maxActiveRuns: "abc"` is clamped instead of becoming NaN (NaN comparisons
  silently removed the quota).
- Finished runs leave `runtime`, `saveChains`, and the 512-entry child-id guard
  instead of growing for the life of the host.
- `store.read()` throws on EPERM/EMFILE/ENOSPC instead of returning null, so a
  filesystem problem is no longer reported as "unknown run".
- A status waiter used to write a `<runId>.watching` marker so a poller in
  another process suppressed the wake-up. Round 2 removed that mechanism: the
  poller can time out just before the terminal write, and then the only
  notification was lost. The wake-up now happens unless a waiter in *this*
  process is about to read the result itself.
- If `execute()`'s own finalizer throws, the run is still forced terminal and
  written, instead of staying active forever.
- `agent.followup()` is awaited, so its failure is reported as
  `delivered: false` instead of escaping as an unhandled rejection.

### Security boundary

- `maxSubagentDepth` (default `1`) is passed as `maxDepth`, so workers cannot
  create their own children. Setting `provider-managed` opts out explicitly.
- `childPreset` is passed as `agentPreset`. That is the only way this host
  version can give a child a narrower tool set: `SubagentStartRequest` has no
  tool filter, and the host's own `tool-subagent` rejects a `toolFilter` config
  and points at presets. A `childTools` allowlist therefore cannot be
  implemented on `dsh@0.2.2-rc.1`; claiming otherwise would be a lie. Documented
  as such instead.

### Evidence

`npm test`: **70 tests, 70 pass** (was 39 before round 1), all offline — fake
store, fake child spawner, temporary directories, no network, no API key. Four
consecutive full runs passed after the polling tests were rewritten around
event gates.

New coverage: recovery with a live pid and with a fresh heartbeat; two
concurrent resumes; two orchestrator instances on one real state directory;
cross-process resume of a live run; resume quota; resume rebuilding limits while
keeping spend; the call budget with `readUsage()` returning null; usage from
failed attempts; cancel against a child that never settles *and* against a
provider that never answers at all; notify ordering (event-driven, no sleeps);
notify re-armed by resume; multi-byte `capText`; `lib/usage.js` (previously zero
tests, now six); store locks; a missing runs directory; a plugin mount without
`subagents`; a plugin with an unusable state directory.

## 2026-11-14 — round 2: second adversarial pass and the stranger review

A second review of the round-1 changes (one process, real directory) and a
stranger review (tarball install into a clean profile, `dsh@0.2.2-rc.1`,
following the README literally) both ran. Everything below is fixed.

### Review of round 1 (must fix)

- **`usage` null crashed the registry.** The "budget with no readable usage"
  test asserted a shape that did not exist. Fixed the test to assert that the
  run reports `usage: null` and that only the spawn counter drives the cap.
- **A slow wake-up could orphan a live run.** The heartbeat was stopped before
  `settle()` awaited `notify`; disk stayed `running` with a frozen heartbeat, so
  another process could reclaim it after 90 s and two processes would run it.
  The heartbeat now runs until the terminal write lands, and notify is bounded
  (15 s).
- **A provider that never answers pinned a run forever.** `spawn` awaited
  `startActivation` with no abort. It is now abortable; a child that appears
  after the abort is disposed immediately. Covered by a test with a promise that
  never settles.
- **A remote lock never expired.** A crashed host on another machine blocked
  resume forever because its pid cannot be checked. Locks older than 10 minutes
  are now broken; local dead pids are broken immediately.
- **The watcher race could swallow the only notification.** Cross-process
  watcher suppression is gone (see above).
- **`store.read()` throwing hit a polling hot path.** Transient
  `EPERM/EACCES/EBUSY/EMFILE` reads are retried three times before failing, so a
  rename on Windows no longer turns `status` into a hard error.
- **The "two resumes" test did not prove the lock.** Added a test with two
  orchestrators and two stores on one real temporary directory: exactly one
  resume wins, the other gets `already being started by`.
- **A remote cancel did not persist `cancelPending`.** It no longer rewrites the
  owner's file; the marker itself is surfaced by `status` as `cancel requested`.

### Stranger review (A–H)

- README: `npx @deepseek-ai/dsh@0.2.2-rc.1` (and an explicit warning that
  `npm i -g dsh` is a different package), `dsh plugin --profile web add
  dsh-superagent` as the main install, `file:` demoted to development, Node
  `>=24.9.0`, `DEEPSEEK_API_KEY` for the default route, DashScope moved to
  "if you added that route", real expected output, a `wait_seconds` note.
- `engines.node` is `>=24.9.0`.
- Pricing matches `provider/model` exactly, then the bare model name.
- `resume` rebuilds limits from the current config (verified by a test where the
  old cap was 1 and the current config allows 3).
- State directory failures are exposed: `recover()` errors are kept and returned
  by every tool, `list()` reports an unreadable runs directory instead of
  returning `[]`, `ENOENT`/`ENOTDIR` are filesystem errors.
- New error classes: `missing-credential`, `unknown-model`; the auth hint names
  `DEEPSEEK_API_KEY` first.
- First-run text: `usage: accounting pending` while active, `interrupted` gets
  a `next: superagent_resume` line, cancelled runs print `skipped`/`cancelled`
  subtasks, elapsed time separates running time from downtime.
- `subagents` is an optional dependency: the five tools mount without it and
  `superagent_start` explains what is missing. Covered by a test.
- `exports` reduced to `.` and `./package.json` (the other subpaths were
  undocumented and had no types).

### Defensible, not changed

- **Stale remote heartbeat while the owner is only paused.** If a machine
  sleeps past 90 s, another machine may reclaim the run. Files are the only
  coordination channel (the user rejected out-of-host IPC), and a machine that
  is asleep cannot refresh a heartbeat or answer a lock. The reclaim records its
  basis and the original process's next save is what a background write would
  do anyway; the mitigation is per-run locking plus `maxActiveRuns`, and the
  README states the assumption.
- **Tool allowlist for children.** Not implementable on `dsh@0.2.2-rc.1`:
  `SubagentStartRequest` has no tool filter and the host's own subagent tool
  rejects one. `maxSubagentDepth` is enforced; `childPreset` is the documented
  equivalent. Claiming a `childTools` list works would be false.

### Next

1. Real-host end-to-end with the cheapest model, evidence under `docs/`
   (start → parallel → aggregate → wake-up → cancel → resume).
2. Embedding surface (MCP vs local HTTP) for other UIs and plugins.
3. One-command install verification from a clean profile; publish only when the
   real-host evidence is in place.
