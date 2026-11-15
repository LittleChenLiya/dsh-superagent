# Changelog

Doc-only releases: npm serves the README from the tarball, so a README edit is
invisible on the package page until something is published. When the edit
changes what a reader would do — install commands, limits, troubleshooting
steps — it gets its own patch version (0.9.2, 0.9.3). Typos and wording ride
along with the next code release. A doc-only version leaves `lib/` and `bin/`
byte-identical to the version before it, and the pinned install line in the
README is updated to the version being released.

## 0.14.1 — 2026-11-15

### Added

- **Plugin card metadata.** `icon.svg` is declared by the package manifest and
  exported as `./icon`; `locale/en.json` and `locale/zh.json` carry the title,
  description, and a `meta.detail` document. In a Chinese UI the card reads
  “超级智能体” with a Chinese one-line description, and the detail page renders
  `docs/DETAIL.zh.md` instead of the English README.
- **A format-1 plugin index** at `plugin-index.json`, with the package name, a
  Chinese title, and a `git` source pinned to a full 40-hex commit, so the
  Discover page can add the index and install or update the plugin in one step.
  The public URL and the two-step instructions are in the README.

### Changed

- `README.md` is now Simplified Chinese-first; `README.en.md` keeps the English
  text and both open with a language switch. `README.zh.md` mirrors the Chinese
  page, and `package.json`'s `description` is Chinese.

## 0.14.0 — 2026-11-15

### Added

- **Attach mode is complete.** With `runtime.browser.attachPort` set, every
  browser tool — listing, clicking, typing, screenshots, scripts — runs on the
  browser the user started with `--remote-debugging-port`, on the tab that is
  already open. The tab keeps its own window size (no viewport override), and
  `browser_close` detaches instead of terminating the user's browser (a blank tab
  created only because no page existed is closed). A port that is not listening
  now fails with the port, a Chrome/Edge start command, and an explicit
  statement that no profile was launched in its place; attach never falls back
  to a fresh profile.
- **Persistent profile option.** `runtime.browser.userDataDir` points a launched
  browser at one dedicated profile, so a sign-in done once is reused on later
  runs. The default is still a fresh temporary profile, which cannot see the
  user's daily cookies; the README spells out the trade-off and ignores
  `userDataDir` while `attachPort` is set.
- **Human checks hand back instead of failing.** `lib/browser.js` classifies
  page text for a sign-in wall, CAPTCHA / "confirm you are human", SMS or
  one-time code, two-factor, and QR login. `browser_open`, `browser_click`, and a
  submitting `browser_type` stop at such a page and return `[attention]` with
  the page, the check, where the person finishes it, and the next call — never a
  failure. New `browser_await_human` polls until the check is gone and reports
  ok, or hands back again at its timeout. It never solves, types, or scans the
  check. A headless launch explains that it has no window and points at
  `headless: false` or attach.
- **Audit distinguishes the connection.** Every browser audit line carries
  `meta.session: "attach" | "launch"`, plus `meta.port` and the reused tab for
  attach, or `meta.profile` / `meta.persistentProfile` / `meta.headless` for a
  launch. Human hand-offs are recorded as `kind: "attention"`,
  `decision: "attention"`, `result: "needs-human"`; attach failures record
  `rule: "runtime/attach-failed"` with the actionable message rather than being
  mistaken for a provider error.

### Changed

- The domain allow-list, irreversible-action confirmation, file-upload refusal,
  stop switch, and worker-tool guard all sit in the same call path as before, so
  they apply unchanged on an attach connection; tests cover each one there.
- `browser_type` masks the read-back value for a password field.

### Fixed

- **Costs are grouped by currency.** A run that used a USD-priced route and a
  CNY-priced route used to add their micro-units and label the sum with the
  first model's currency. It now keeps one subtotal per currency and prints
  them separately (`¥0.0952 + $0.0248`) in the run line, `superagent_list`'s
  ledger line, the `watch` footer, the exported `README.md`, and the HTML
  report; a mixed window gets one cost curve per currency. Single-currency runs
  keep the existing `¥0.3600` format, and an unpriced model stays `unpriced`
  rather than becoming zero.

## 0.13.0 — 2026-11-15

### Added

- **Goal mode.** `superagent_start` accepts `goal_mode: true` with an
  `acceptance` list, and the run no longer ends when its subtasks do. Each
  condition is `{id?, text, check?}`; a `command` or `file` check is executed by
  the plugin, so that verdict rests on a real exit code or a real file, and only
  an unchecked condition goes to an independent acceptance model. A failed round
  starts another with what is still missing, bounded by `max_rounds` (5),
  `max_wall_clock_minutes` (60), and `no_progress_rounds` (2), and stops with a
  written reason on the round cap, the wall clock, the deadline, a budget stop,
  an open attention item, or two identical failing rounds. One notification when
  the loop ends, none between rounds. `lib/goal.js`; off unless asked for, and it
  adds no tool.
- **Scheduled runs.** New `superagent_schedule` tool (`create`, `list`, `pause`,
  `resume`, `delete`, `run-now`) stores a plan — goal or expanded template, cron
  or fixed interval, time zone, its own budget and concurrency policy — and
  starts runs with nobody calling `superagent_start`. `lib/cron.js` is a
  zero-dependency 5-field parser (`*`, `*/n`, ranges, lists, month and weekday
  names, 0 or 7 for Sunday; seconds, `@`-macros, `L`, `W`, `#`, and `?` are
  refused by field). Missed windows are not replayed: `latest` runs the newest
  one and records the rest as missed, `none` skips them. A plan never overlaps
  itself, one slot stays reserved for manual runs by default, and three
  consecutive failures pause the plan and say so once. Plans survive a host
  restart, and an install with no plans behaves exactly as before.
- **Plan honesty and capability preflight.** The planner now returns
  `ambiguities` (phrases it cannot map to a concrete object), `needsInput`
  (questions only the user can answer), per-subtask `assumptions`, and
  `requires` capability tags. A plan that only raises questions stops the run as
  one decision point instead of guessing; assumptions are stored on the subtask
  and printed in status and the report. `preflightCapabilities` compares
  `requires` with the tools the session actually has before a worker starts: a
  missing capability blocks that subtask with the capability and the fix named,
  cascades `skipped` to everything downstream, and is never counted as success.
  When the host cannot list its tools the preflight records `unavailable` and
  blocks nothing.
- **User profile.** Optional cross-task memory (`memoryUserProfile: true`) in
  `lib/user-memory.js`: three categories (`fact`, `preference`, `decision`) in
  three files, a decision stored only with its reason, `superagent_memory` with
  `layer: "user"` reading and writing it, and forgetting as a real deletion
  under a lock with no tombstone. Everything is redacted before it is written,
  and nothing is constructed unless the operator turns it on.
- **Conversation console.** `lib/console.js` and `public/console.html` serve a
  loopback page (`consolePort`) that talks to a real Host Session through
  `sessionController` — create, prompt, follow, observe state — so a conversation
  can be started, followed up, watched while its derived run works, and have its
  attention questions answered from the page. Server-sent events stream updates;
  the one-time token is written to `<stateDir>/console.json`. Without
  `sessionController` the page says it is unavailable instead of drawing a
  fake conversation.
- **Runtime control: a real browser and, on Windows, the real desktop.** New
  opt-in layer (`lib/browser.js`, `lib/desktop.js`, `lib/runtime-control.js`)
  that registers `browser_*` and `desktop_*` tools only when
  `runtime.enabled` is true. The browser is driven over the DevTools protocol
  through Node's built-in `WebSocket` and gets its own `--user-data-dir`, so
  there is no npm dependency and no access to the user's cookies or logins. The
  desktop half compiles a `user32.dll` helper with `Add-Type` inside
  `powershell.exe`, posts input without activating the target window by default,
  and only goes foreground on `activate: true` when the config allows it.
  Element lookup accepts visible text, ARIA name, role, CSS selector, or the
  index a previous `browser_elements` returned, and every click and typing call
  screenshots afterwards.
- **Gates and audit.** An emergency stop file refuses every action while it
  exists; `file://`, other non-HTTP schemes, and hosts outside the allowlist are
  refused; file inputs are refused; labels that read submit/delete/pay (or 提交/
  删除/支付) need `confirm: true`. Every attempt writes one audit event with
  action, target, decision, result, rule, and duration — including refusals,
  which used to be indistinguishable from failures.
- **Guard coverage for worker agents.** `lib/guard.js` refuses `browser_*` and
  `desktop_*` calls from bound child agents with rule `guard/runtime-tool`,
  unless `guard.allowRuntimeTools` is set. Runtime control belongs to the
  session that mounted the plugin; a worker driving the user's screen is not
  something to allow by default.
- **Two runnable proofs.** `scripts/runtime-demo.mjs` and
  `scripts/runtime-desktop-demo.mjs` assert against the target's own state (a
  DOM counter, a window's click counter and received characters) rather than
  against the tool's own report.

### Changed

- The default tool set is twelve: `superagent_schedule` joins the existing
  eleven. `bin/doctor.js` and its test expect twelve, and a profile that never
  enables runtime control still sees exactly these twelve.
- `README.md` gained "Goal mode", "Scheduled runs", "Conversation console",
  "User profile", and the plan-honesty and preflight entries under
  "Progress, decisions, and artifacts", and its tool table matches the twelve
  registered tools.

### Fixed

- **Worker checkouts and deliverable verdicts.** A worker starts in its own
  worktree and its prompt names the root that relative paths resolve against.
  A deliverable found only in the base checkout is reported as `misplaced`, not
  `missing` — one means the file was produced in the wrong root, the other means
  it was not produced at all. The worktree pool is anchored to the session's
  sandbox boundary, so a host started from another directory no longer creates
  checkouts outside the workspace it guards.

### Notes

- `README.md` gained a "Runtime control" section that lists the tools, the
  gates, and the boundaries that are real: no borrowing of existing browser
  logins, no CAPTCHA solving, no anti-detection, and no background typing into
  Chromium or Electron content.
- `Add-Type` needs a writable `%TEMP%`. The desktop helper points `TEMP`/`TMP`
  at `%LOCALAPPDATA%/Temp/dsh-runtime-control`, because a restricted token that
  can read `C:\Windows\TEMP` but not write there makes the C# compiler report a
  misleading "source file not found".

## 0.12.1 — 2026-11-15

### Fixed

- **Line endings in `bin/` and `lib/`.** Added `.gitattributes` with
  `*.js text eol=lf` for both directories and normalized the tracked files to
  LF. npm rewrites the shebang line of bin scripts during install (CRLF → LF,
  one byte per file), which made `doctor`'s registry checksum comparison report
  a false `Registry match` failure for `bin/*.js` on npm-installed copies. With
  the tarball now shipping LF, installed files match the published package
  byte-for-byte.

## 0.12.0 — 2026-11-15

### Added

- **Worker safety guard.** Child tool calls are now checked on the host's
  `tools/pre-execute` / `ctx.tools.guard` pipeline. Writes are limited to the
  child's workspace and the OS temp directory; credential stores and
  `.git/config` / `.git/hooks` are refused for reading and writing; system
  directories are refused for writing. Default command rules block disk
  formatting, system scheduler and registry changes, writes into system
  directories, destructive recursive deletes whose target is `/`, `~`, `.`,
  `..`, a wildcard, or outside the workspace, permission nukes, and commands
  that name a credential store. `guard.allowCommands` is an explicit,
  audited override. Blocked calls surface in `superagent_status` and in a
  `## Safety guard` report section. See “Worker safety guard” in the README
  for the full defaults and their rationale.
- **Permission policy.** `<stateDir>/policy.json` (or `policyFile`) lets a person
  say which paths may be written, which commands may run, which action classes
  need a human, and what the default level is per run. The file accepts `//`,
  `#`, and `/* */` comments, validates against a schema, and reports every
  problem with file, line, and column. It only tightens: deny wins, explicit
  allow entries record what they relaxed, and an invalid policy fails closed. A
  start the policy denies is refused before any run record exists; a start held
  for confirmation needs `approve_policy: true`, which is logged.
- **Audit trail.** Append-only JSONL at `<stateDir>/audit/audit.jsonl`: tool
  calls, path writes, commands, blocks, approvals, attention decisions, and run
  lifecycle, each with run id, subtask id, actor, timestamp, decision, result,
  and duration. Appends are serialized in-process and locked across processes;
  a torn tail or a damaged line is reported and skipped instead of hiding the
  log. `audit: false` turns the trail off without changing run behaviour.
- **`superagent_audit`** queries by run, subtask, kind, decision, result, target,
  and time window, and exports the matching events as one JSONL or CSV file.
- `createAuditor(...).attachGuard(fn)` is the seam for a separate path/command
  guard: it can tighten a decision, never relax one.
- `superagent_inject(run_id, message, subtask_index?, wait_seconds?)` steers a
  running child instead of waiting for the next prompt. It calls the host's
  documented live channel (`subagents.sendMessage`, which lands in the same
  `Agent` inbox that `steer`/`inject` expose), so the message is claimed at the
  child's next pre-step and becomes part of its next model request. A child
  that had already decided to stop runs one more turn to read it. Receipts
  record `latencyMs` from acceptance to the claim, or a `missedReason` when the
  child is cancelled, disposed, or finishes before another boundary. On a real
  `dsh@0.2.2-rc.1` host the measured delay was 2986 ms with a 4 s child step
  and 6978 ms with an 8 s step, i.e. bounded by the remainder of the running
  step, not by the plugin. A host without that channel degrades to the followup
  queue and the reply labels it as such.
- **Multi-device sync over git.** `dsh-superagent-sync` turns the state
  directory into a repository and carries it between machines through any git
  remote — no server, no account, no dependency. `init <remote>` writes a
  managed `.gitignore` block (credentials, locks, cancel markers, quarantine
  files, temp files, logs, machine identity) and makes the first commit;
  `pull` fetches and merges, stashing uncommitted local work first and saying
  so; `push` commits local state and pushes, reporting a rejection instead of
  forcing; `status` reports ahead/behind counts, uncommitted files, stashes,
  and conflicted paths. A conflict stops the merge with both sides kept and the
  paths listed — nothing is resolved automatically. Run records were already
  one file per run, so ordinary concurrent work on two machines does not
  collide; the remaining shared surface is an append-only memory scope. The
  README documents the limits: no realtime channel, no cross-machine lock, no
  key distribution.
- **Local workspace panel.** `workbenchPort` (off by default, loopback only)
  serves an IDE-shaped page from `public/workbench.html`: file tree, text editor,
  diff preview before save, and a run view that lists the files a run changed.
  The plugin reads and edits the filesystem itself, so no host API is involved.
  Every request needs the per-process bearer token in `workbench.json`; absolute
  paths, traversal, symlinks out of the root, the state directory, binaries, and
  files above 512 KB are refused with a reason. Saving requires the hash and
  mtime the editor read, so an external edit is never overwritten.
- `dsh-superagent-workbench` runs the same panel standalone, with `--root`,
  `--port`, and `--state-dir`; no host is required.
- Run records now carry `changes` (recorded when the panel is on), which is what
  the panel's run view reads and diffs against `git HEAD`.

## 0.11.0 — 2026-11-15

Runs became something you can talk back to and shape: instructions and answers
reach a run that already exists, planned subtasks can depend on each other,
workers can be isolated in their own worktrees, and the panel and report show
parallel structure instead of opaque rows. Runs are now priced down to the
subtask, spending is kept in a ledger, common goals start from a template, and
an install can check itself. No runtime dependencies were added, and the package
still ships one file per module from `lib/`.

### Added

- **Direct mode.** `superagent_start` takes `mode: "direct"`: one worker does the
  whole goal, with no planner, no aggregation, and no self-heal round, and its
  reply becomes the report verbatim. The run record, quota, deadline, cancel,
  budget, milestones, and per-child usage accounting are identical to a planned
  run. `mode: "planned"` is the default and unchanged.
- **Queueing instead of a hard failure.** `superagent_start` takes
  `queue: true`: when `maxActiveRuns` is in use the run returns
  `status: "queued"` with `queue.position` / `queue.of`, and starts automatically
  when an active run finishes. Waiting runs do not count against
  `maxActiveRuns`, are persisted with an owner heartbeat, start oldest first, and
  renumber when one is cancelled. `maxQueuedRuns` (default 5, 0 disables) caps the
  line and `queueTimeoutMinutes` (default 30) fails a run that never got a slot,
  without spending anything. `queueOnFull: true` makes queueing the default for
  every start; without it a start that does not pass `queue: true` still gets the
  speed quota error.
- **Relevance-ranked memory recall.** `superagent_memory` takes
  `action: "search"` with `query` and/or `tags`; a new note supersedes the older
  one with the same key, and the planner digest now ranks notes against the run's
  goal instead of only taking the newest ones.
- `superagent_followup(run_id, message)` appends an instruction to an active
  run. It stays next-prompt by design: the next worker spawn or the aggregation
  carries it, whichever comes first, and subtasks already running or finished
  keep their results. Each instruction records `appliedAt` / `appliedAtStage`,
  or `missedAt` with a reason when the run settled before another boundary ran.
  A paused run keeps the instruction for its next resume; a completed run
  refuses it. A run owned by another process is refused rather than written,
  because that owner's next save would erase it.
- `superagent_answer(run_id, attention_id?, answer, wait_seconds?)` answers one
  structured attention item. Attention items now carry stable ids (`q1`, `q2`, …)
  from a per-run counter; the answer is recorded on that item and the run
  continues — an active run at its next boundary, a terminal run by reopening so
  its aggregation runs again with the decision. A question retired by a resume
  is archived to `attentionHistory` with `expiredAt`, so a late answer is
  refused as expired instead of being matched to whatever is open now. Unknown
  ids, already answered questions, and an answer whose text is another
  question's option are refused with the id to use instead.
- **Per-worker workspace isolation.** `workspaceIsolation: true` gives every
  worker its own git worktree on `superagent/<runId>-w<n>`, harvested into a
  commit and merged back into the main checkout one at a time. A conflict aborts
  the merge, keeps both branches, and is reported by status and the wake-up
  message. When isolation is unavailable the run continues in the shared
  directory and says so.
- **Dependency-aware plans.** The planner may give a subtask an id and a
  `dependsOn` list. The dependent waits (`waiting`) instead of starting, and its
  prompt carries the finished dependency's report; independent subtasks still
  run in parallel. A dependency on an undeclared task is `skipped` with the
  reason, a failure skips everything downstream instead of reporting it as done,
  and a cycle rejects the plan before any subtask starts. Status, notifications,
  and reports distinguish waiting from running.
- **Parallel structure in the panel and the report.** Runs alive at the same
  moment share a numbered gutter in `watch`, so concurrent work is visible as a
  group, and a waiting row leads with the run holding its slot and its queue
  position. The HTML report lists each worker's retry chain and its share of the
  run's wall clock next to the outcome.
- **Documentation site.** `docs/site/` holds a quickstart, a comparison page,
  and a single-file landing page; nothing in `lib/` changed for it.
- **Per-run and per-subtask pricing.** `pricing` in the plugin config maps a
  model to input/output prices per million tokens. Every run and every subtask
  now carries a `cost` with micro-unit totals, and status, the panel, and the
  report print it (`cost ¥0.3519+`). A model absent from the table is reported as
  `unpriced` — never as `0.0000`, and a total that mixes priced and unpriced work
  is printed with a trailing `+` so it cannot be read as complete.
- **Spend ledger.** `lib/ledger.js` keeps a durable per-run spend record, mounted
  from settled runs so a restart backfills what no tool was watching, and
  `superagent_status` reports the rolling spend and how many runs in the window
  were only partially priced.
- **Workflow templates.** `superagent_template` lists, shows, and expands a
  reusable goal template (built-ins plus files under the template directory), so
  a common goal is expanded into its steps instead of being retyped. Templates
  are optional: a template directory that cannot be created is logged and the
  run tools keep working.
- **Install self-check.** `dsh-superagent-doctor` reports, without installing or
  editing anything, whether every imported file is in the `files` whitelist and
  on disk, whether the installed copy matches its published tarball, whether the
  profile registers the bundle row, and whether all nine tools are registered.
  Every failure prints the command that fixes it. `npm test` also asserts that
  `npm pack --dry-run` ships every file reachable from the entry points
  (`scripts/check-pack.mjs`), which is the check the 0.9.x tarball lacked.
- **Run archives.** `dsh-superagent-archive` (`bin/archive.js`) adds three
  subcommands. `prune` lists terminal runs older than `--older-than <days>`,
  optionally filtered by `--status`, with the files and bytes it would remove;
  it deletes nothing unless `--confirm` is given, and it never touches a run
  that is still active or whose `.lock` another process holds. `export` writes
  one run as a self-contained directory (README with the report, `report.md`,
  `run.json`, per-subtask markdown and JSON, guard records, `usage.json`, and a
  manifest with a SHA-256 per file), as one JSON bundle, or as one offline HTML
  page with the bundle embedded. `import` reads any of those back into the
  store and refuses to overwrite a local run with the same id. `store.js` gained
  `planPrune`, `buildArchive`, `exportRun`, and `importRun`; `prune` gained
  `dryRun` and `statuses` and now returns the plan alongside `removed`. No
  runtime dependency was added.
- New config: `queueOnFull`, `maxQueuedRuns`, `queueTimeoutMinutes`,
  `workspaceIsolation`, `workspaceRoot`, `pricing`.

### Changed

- A single completed subtask still short-circuits aggregation, unless the run
  has instructions or answers: then the aggregation prompt is built, because
  otherwise reopening the run would return the old report and silently drop the
  decision.
- `superagent_resume` reopens a `completed` run only when it holds an answer
  that never reached a prompt; every other completed run keeps its existing
  no-op behaviour. Without this, an answer that could not be applied (quota or
  lock) would be stranded behind a "resume the run" instruction that did
  nothing.
- Status prints the attention id, any recorded answer, and how many instructions
  were applied, are waiting, or never took effect; notifications lead with the
  question id so `superagent_answer` can be called directly.





## 0.10.0 — 2026-11-15

The dispatch, progress, delivery, and memory layer. No runtime dependencies were
added, and the package still ships one file per module from `lib/`.

### Added

- **Cross-run memory.** `<stateDir>/memory/<scope>.jsonl` keeps short notes the
  aggregator writes (`decision`, `pitfall`, `next`, `dispatch`, `note`) plus the
  six most recent runs derived from the run store. The digest is bounded
  (12 notes / 1600 characters / 2600 characters total), compacted above 400
  lines or 128 KB, and injected into the planner and aggregator prompts. A newer
  note with the same key supersedes an older one, `forget` retracts it, and
  notes older than 30 days expire. Secrets are redacted before storage; the
  directory carries its own `.gitignore` and is never in the package.
- Added `superagent_memory` (`list`, `set`, `forget`). Existing tools keep their
  arguments and output; this is the sixth tool.
- **Layered memory.** `rules` and `profile` scopes are read into planning and
  aggregation ahead of the run scope; `superagent_memory` takes `scope`. A run
  only writes its own scope, so a model cannot overwrite a project rule.
- **Duplicate dispatch is collapsed.** The same active goal (case and whitespace
  ignored) returns the existing run id with `deduped: true`, under a per-goal
  claim so two processes sharing a state directory cannot both start it. The
  match is scoped to the owning session, so two sessions that ask for the same
  generic goal still get their own runs. `allow_duplicate: true` on
  `superagent_start` (or `allow_duplicate` on the control `start` body) opts
  out. A `wait_seconds` call keeps the `deduped` marker in its result.
- **Transient backoff.** A rate-limit, quota, timeout, or 5xx failure now waits
  2s, then 4s, then 8s before the next attempt instead of retrying immediately.
- **Recovery note.** A resumed run tells each worker what failed and instructs it
  to inspect files, `git status`, `git log`, and remote state before repeating an
  externally visible action.
- **Structured attention.** A worker or the aggregator may append one fenced
  `attention` block. It is stripped from the report, stored as `attention.items`,
  shown as `needs your decision:` in status, and leads the notification.
- **Attention text is bounded.** Question, options, and reason are collapsed to
  one line and capped at 500 / 200 / 300 characters, so neither status nor a
  notification can be given forged extra lines. An invalid attention block is
  not stripped silently: its raw text stays in the report and status prints
  `attention: <reason>`.
- **Milestones.** `plan_ready`, `running`, `aggregating`, and `settled` are
  recorded with timestamps and shown in `superagent_status`; nothing is pushed.
- **Report file.** A terminal report is written atomically to
  `<stateDir>/reports/<runId>.md` (directory carries `.gitignore: *`), recorded
  in `run.artifacts`, and shown in status. `keepRuns` pruning removes it together
  with the run record.
- **Quiet by default.** Only a delivered, failed, or partially finished run may
  wake the session; a cancelled run never does, and progress is never pushed.
  `maxNotificationsPerHour` (default 3) buffers extra runs into one summary.
- **Notification outbox.** A refused wake-up is retried with backoff
  (`notifyRetries`, `notifyRetryDelayMs`) and messages for one session stay in
  order. A buffered batch is put back into `pending` when the send fails, so a
  later message still carries those runs; it is dropped only after three failed
  deliveries.
- **Self-heal before reporting.** A subtask failure that looks transient
  (quota, rate limit, timeout, 5xx) gets `autoResumeRounds` (default 1) more
  rounds, optionally on `childModelFallback`. The failure message now says what
  was tried, and `self-heal:` appears in `superagent_status`.
- **`memoryMaxEntries` is a compaction trigger.** Exceeding it, 400 lines, or
  128 KB compacts the notebook on the next write.
- New config: `memory`, `memoryScope`, `memoryMaxEntries`, `memoryMaxAgeDays`,
  `memoryDigestEntries`, `memoryDigestChars`, `maxNotificationsPerHour`,
  `notifyRetries`, `notifyRetryDelayMs`, `autoResumeRounds`,
  `childModelFallback`.

### Changed

- **A resume is never refused by the concurrency quota.** A `superagent_resume`
  only finishes work that already exists, so it is not counted against
  `maxActiveRuns` and works even when the cap is full; only `superagent_start`
  creates new spend and is subject to the cap. The resume is still
  session-scoped: it may only be issued by the session named in the run's
  `parentSessionId`. `force` (`force` or `override_quota` over HTTP) is still
  accepted so an existing caller keeps working, but it no longer changes
  anything.
- `superagent_status` gained the milestone line, the attention line, and the
  report file path; `superagent_start` gained `allow_duplicate`; the control
  `start` body gained `allow_duplicate`, and `resume` still accepts `force`.

### Fixed

- Memory, notification, and report-artifact writes are fail-open or retried, so
  a transient filesystem error cannot turn a finished run into a failed one; a
  report that is already written stays on disk and is listed in status.
- Test suite: 168 tests, 0 failures; `npm test` and `node --test` discovery
  agree.

## 0.9.3 — 2026-11-14

Documentation only; no code change.

- Both install commands name the version (`@xiangyixie/dsh-superagent@0.9.3`),
  and the Quickstart explains why: pnpm's minimum release age skips packages
  published in the last few hours, so a bare `add` installs an older version and
  still reports success. A bare install here resolved 0.9.0 while 0.9.2 was
  current.
- Added the command that reports what actually landed:
  `npm ls --prefix <DSH_HOME>/profiles/web @xiangyixie/dsh-superagent`.
- The troubleshooting rows for a missing tool and for
  `Cannot find module .../lib/control.js` now carry the pinned reinstall command.

## 0.9.2 — 2026-11-14

Documentation only; no code change. npm renders the README from the tarball, so
this version exists to put the rewritten opening on the package page.

- The first screen now answers three questions in order: what the plugin is for,
  when it is the wrong tool, and the first command to run after installing.
- `Naming` moved from the top to just above `Development`. The copyright line
  and the "personal project, not affiliated with DeepSeek" statement moved to
  the top, where they are read.
- `Known limits` gained the isolation boundary: children use the host's
  credentials and filesystem and are only as sandboxed as the host makes them.

## 0.9.1 — 2026-11-14

Metadata-only release. No code or behaviour change; the only file contents that
differ are `package.json`, `README.md`, and this changelog.

- Added the `author` field (`Admire (LittleChenLiya)`), matching the copyright
  line in `LICENSE`. The registry metadata carries it from this version on
  (`npm view @xiangyixie/dsh-superagent author`); the npmjs.com package page has
  no separate Author row in its current layout — it lists Collaborators — so the
  visible credit is the copyright line in the README's License section.
- The README "License" section now names the copyright holder, links
  `LICENSE`, and says that the npm scope `@xiangyixie` and the GitHub account
  `LittleChenLiya` are the same author.

## 0.9.0 — 2026-11-14

Hardening pass before the first publish. No behaviour change for the happy
path except the new spending caps, the cost line, and two operator utilities.

### Published as `@xiangyixie/dsh-superagent`

- npm already carries a `dsh-super-agent` that its similarity check treats as
  the same name as the unscoped one, so the first release goes out under the
  author scope. The project, the repository, the plugin row id (`superagent`),
  the five tools (`superagent_*`), the state directory, and both bin names are
  unchanged; only the install specifier differs:
  `dsh plugin --profile web add @xiangyixie/dsh-superagent`.

### Watch panel and HTML report

- `dsh-superagent-watch` draws one line per run — id, status, calls used against
  the cap, elapsed, current activity, parent session — in the alternate screen.
  A status change repaints within 200 ms; an idle panel costs one small file
  read per second. Ctrl-C, SIGTERM, and a closed pipe restore the cursor and
  leave the alternate screen; `--once` prints one plain frame and never takes
  over the screen.
- `dsh-superagent-report` renders recorded runs into one self-contained HTML
  file: inline CSS and inline SVG, no script, no font, no image, no network. It
  contains a timeline with each run's start, end, and derived
  planning/work/merge phases; swimlanes whose count is the peak concurrency;
  cumulative model-call and cost curves; explicit failure, cancellation, and
  interruption annotations; and a run table.
- Neither utility adds a dependency. The package is still `dependencies: {}`;
  the tarball grows from 11 to 15 files (73.4 kB packed, 240.7 kB unpacked).

### Embedding surface (local HTTP)

- New opt-in `controlPort` exposes the five operations as JSON over loopback:
  `GET /`, `GET /health`, `GET /runs`, `GET /runs/:id`, `POST /runs`,
  `POST /runs/:id/cancel`, `POST /runs/:id/resume`. Off by default; `0` picks a
  free port. Another UI can start and watch runs without importing `lib/`.
- Bound to `127.0.0.1` only, with a per-process bearer token written to
  `<stateDir>/control.json` (mode `0600`), a `Host` check that blocks DNS
  rebinding, no CORS headers, a 64 KB body cap, and a 60 s limit on receiving a
  request (a 300 s long poll is unaffected: the wait happens while the response
  is produced).
- Every route goes through the same orchestrator as the tools: quota, budgets,
  run locks, cross-process cancel, and recovery behave identically. `POST /runs`
  requires `session_id` of a live session; a run still needs a real parent agent
  for its children, and a missing session is refused as `no-session` rather than
  started without an owner.
- Replies carry the same `text` as the tool result, plus the stored run object
  (`schemaVersion: 1`). Transport errors have their own ids (`unauthorized`,
  `forbidden-host`, `no-session`, `body-too-large`, …) so a client can tell a
  bad token from a broken run.
- The contract, security model, and client examples are in
  [docs/embedding.md](https://github.com/LittleChenLiya/dsh-superagent/blob/main/docs/embedding.md);
  verified against real `dsh@0.2.2-rc.1` with 17 checks in
  `docs/e2e/transcripts/control-plane.log`, plus a two-host cross-process cancel
  run in `docs/e2e/transcripts/cross-cancel.log`.
- Review fixes before release: a dispose that lands while the port is still
  binding now closes it instead of leaving an orphaned listener; a failed
  discovery write closes the server instead of running unreachable; `/health`
  does no state work, so a liveness probe cannot reclaim runs; a blank goal is
  a 400 `no-goal` and a profile without a subagent service is a 503
  `no-subagents` instead of a 500.
- A second review pass added: the plane starts only after the state directory
  exists (a fresh `DSH_HOME` used to leave it off for the whole host lifetime);
  discovery files carry a per-plane `instanceId`, so a reloaded plugin does not
  delete the newer plane's file; a concurrent `start()` shares one listener;
  `GET /runs?limit` also limits the returned array; a missing goal is reported
  before a missing session; a worker session is refused by `superagent_cancel`
  as well; and a malformed `controlPort` (`""`, `" "`, `true`) can no longer
  coerce to an accidental listener.

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
  checked before every child spawn. Hitting one stops spawning: the run ends
  `partial` when at least one subtask finished and `failed` when none did, keeps
  the reports that did finish, and leaves the rest `pending` for a resume.
- A tool's `max_subtasks` / `max_parallel` / `deadline_minutes` can narrow the
  configured cap but never widen it: the config stays the operator's control.
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
  `detail: <untouched host message>`, covering 19 known failure shapes,
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
- A lock left by a dead process on this machine is broken immediately; a live
  local process keeps its lock however long the run takes; a lock from another
  machine is broken after 10 minutes, because its pid cannot be checked.
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

### Real-host end-to-end (2026-11-14)

The first run against a real `dsh@0.2.2-rc.1` host (keyless stub model, full
record in `docs/e2e-2026-11-14.md`) found four behaviours that the offline
suite could not see:

- **A graceful host shutdown buried resumable work as `failed`.** When the
  `subagents` service disappears mid-run (a one-shot headless turn ends),
  children throw "service unavailable". That used to burn both attempts and
  settle the run `failed`. It is now recognised as the host going away: the
  unfinished subtasks stay `pending`, no attempts are spent, and the run
  settles `interrupted` with `note: the host shut down while this run was
  active`. `superagent_resume` picks it up in the next host.
- **A dead pid was ignored for 90 s.** `ownership()` trusted a fresh heartbeat
  before checking the owner pid, so a `kill -9` left the run `running` for a
  minute and a half on the very machine that could prove the pid was gone. On
  a run written by this machine, a dead pid now wins over the heartbeat; a run
  from another machine on a shared directory still trusts the heartbeat.
- **A reclaimed run claimed its cost was unknown.** Recovery now republishes
  `run.usage` from `usageByChild` and recomputes `cost`, so an interrupted run
  shows the money already spent instead of "not computed".
- **Per-subtask usage was often `null` after a normal run.** The read at child
  completion can race the log flush; the settle pass now writes the final
  per-child snapshot back onto each subtask.

Also: the plugin no longer ships a price for `qwen-flash` (the README already
promised that nothing is priced out of the box); the table is empty unless the
profile configures one.


### Install and first run

- Requirements corrected to what `dsh@0.2.2-rc.1` needs: Node `>=24.9.0`, and
  the default route's `DEEPSEEK_API_KEY` (not a DashScope key).
- Quickstart no longer tells people to `npm i -g dsh` (that is an unrelated
  package); it uses `npx @deepseek-ai/dsh@0.2.2-rc.1` and
  `dsh plugin --profile web add @xiangyixie/dsh-superagent`.
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

- 86 offline tests (`npm test`): fake store, fake child spawner, no network, no
  API key. Covers cross-process cancel, orphan reclamation in both local and
  shared modes, concurrent and cross-process resume, resume quotas and limit
  rebuilding, budgets with and without readable usage logs, pricing keys, a
  child that ignores abort, notify ordering, corrupted state, a missing state
  directory, retention, error text, usage-log reading, the HTTP control plane
  (auth, transport errors, discovery lifecycle, start/stop races), and a full
  plugin mount. Polling-based tests were rewritten around event gates; five
  consecutive full runs pass.
