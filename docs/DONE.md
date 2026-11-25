# Definition of done

A release is allowed only when **every** item below is answered "yes" by a
recorded check, not by an opinion. Each item names the evidence that answers it;
evidence lives under `docs/` and is linked from the row.

Status values: `MET` (recorded evidence exists for the version and scope named
in the row), `PENDING` (no current evidence yet), `BLOCKED` (an external
dependency — credential, money, a publish — is missing; the blocker is written
in the row).

This is the live **0.25.0** release gate, not a historical archive. Older
transcripts are retained and labelled with their original version; a historical
`MET` does not clear a current-version check. B9 covers only the earlier core
paths; scoped host-extension evidence is recorded under E5.

## A. A stranger can install it

| # | Check, answerable yes/no | Evidence | Status |
| --- | --- | --- | --- |
| A1 | `npm pack` produces a tarball with no test, harness, or credential files. | 0.25.0 `npm pack --dry-run`: 77 files; `check-pack`: all 57 entry-reachable files shipped | MET |
| A2 | On a `DSH_HOME` that never ran this plugin, `dsh plugin --profile web add <packed tarball>` succeeds with the exact README command. The bare registry name is the same command once G1 unblocks. | `docs/e2e-0.25.0.md`: final 0.25.0 tarball installed into fresh headless and web profiles | MET |
| A3 | After A2, `dsh --profile web --dump-config` contains the `dsh-superagent` bundle row. | `docs/e2e-0.25.0.md`: composed profile contains the superagent bundle | MET |
| A4 | A fresh session can call all five `superagent_*` tools; none returns "unknown tool". | `docs/e2e-0.25.0.md`: `superagent_help` then `superagent_start`; doctor reports 14/14 expected tools registered | MET |
| A5 | Every Quickstart command that does not need the package on the registry runs verbatim on a clean home; no undocumented env var or manual edit. The tarball form is written in the README. | `docs/e2e-0.25.0.md`: clean-home tarball install; quickstart pins 0.25.0 | MET |

## B. It works in a real host

Verified against real `dsh@0.2.2-rc.1` with a local stub model (no credential on
the build machine; see B8). B1–B8 retain **historical 0.9.0** evidence from
2026-11-14; they were not rerun against the uncommitted 0.25.0 changes. B9
records the earlier 0.25.0 core-path smoke in `docs/e2e-0.25.0.md`; it predates
the host-integration extensions and does not verify them. E5 records the later
unit/fake and scoped real-host evidence, including its explicit exclusions.

| # | Check, answerable yes/no | Evidence | Status |
| --- | --- | --- | --- |
| B1 | `superagent_start` on a real host produces a plan with ≥2 subtasks and a terminal `completed` run. | `20261114T080127-372d` | MET |
| B2 | At least two subtasks are observed `running` at the same instant (parallelism is real, not sequential). | `transcripts/overlap-trace.jsonl` | MET |
| B3 | The aggregator call happens and `report` is non-empty and contains both subtask findings. | `transcripts/start-status.log` | MET |
| B4 | `superagent_cancel` on a live run returns `cancelled` in ≤10 s and no further child is spawned. | Historical 0.9.0: 1.99 s, spawns frozen at 3, `transcripts/cancel.log`. 0.25.0 offline 678/678: queued cross-process cancel and cancel during workspace preparation spawn no child; real host not rerun. | MET (historical host; current regression covered) |
| B5 | After the host process disappears mid-run, the next host reports `interrupted`; `superagent_resume` completes only the unfinished subtasks (completed ones keep their original `childId`). | Historical 0.9.0: `transcripts/kill-and-resume.log`; 0.25.0 real host not rerun. | MET (historical) |
| B6 | `notify` wakes a live session when nobody polls. | Historical 0.9.0: `notify.delivered: true` on `20261114T075657-b729`; 0.25.0 real host not rerun. | MET (historical) |
| B7 | A headless host that exits before the run finishes records `notify.delivered: false` with the reason, and status prints it. | Historical 0.9.0: run `20261114T074822-6059`; 0.25.0 real host not rerun. | MET (historical) |
| B8 | The same paths are exercised with the default `deepseek-official` route and a real key, with the real cost printed. | Historical 0.9.0: `docs/e2e/transcripts/b8-real-route.log`, real run `20261114T105744-e272` on `deepseek-official/deepseek-v4.1-flash-1017` — 3 calls, 1882 in / 7363 out / 19456 cache-read, printed `cost: ¥0.1016` from DashScope peak rates. The `byte.haoduotoken.com` credentials cannot reach deepseek models (403), so the run used the same Qwen key on DashScope. 0.25.0 real route not rerun. | MET (historical) |
| B9 | The earlier packed 0.25.0 core build passes real-host smoke for tool activation, run completion, control plane, cancellation, recovery, archive import, and browser panels. Host-integration extensions are excluded and tracked by E5. | `docs/e2e-0.25.0.md`: DSH 0.2.2-rc.5, fresh headless/web profiles, completed run `20261125T090139-3876`, control probe all passed, cancelled run `20261125T090602-f2d5`, resumed run `20261125T090219-8f23`, read-only archive import, doctor 0 failed, real-browser 1440/375px checks | MET (core paths only) |

## C. Money is accountable

| # | Check, answerable yes/no | Evidence | Status |
| --- | --- | --- | --- |
| C1 | Measured token counts equal the sum of the child session logs read directly by an independent script. | `transcripts/verify-usage.log` | MET |
| C2 | `cost` equals `tokens × configured price` to the printed precision, for a route with a price. | `$0.0225` vs `0.022480` | MET |
| C3 | An unpriced model makes the run say the cost is not computed, never a fabricated zero. | `transcripts/unpriced.log` | MET |
| C4 | `maxModelCallsPerRun: N` stops at N spawns on a real host (the aggregator is a spawn too) with the budget error text. | cap 2 → `spawns: 2` | MET |
| C5 | When usage cannot be read, the run prints the lower-bound note and the call budget still stops it. | cancel run note + offline test | MET |
| C6 | `superagent_resume` keeps spend and rebuilds limits from current config; raising the cap makes a resumed run continue. | 2 → 80, completed with 1420 tokens | MET |

## D. Safety boundary

D1–D5 retain historical evidence; only D3–D5 have changed-code regressions in
the earlier 678-test offline snapshot. Those regressions do not claim a 0.25.0
real-host rerun (see B9); extension-specific boundaries are recorded under E5.

| # | Check, answerable yes/no | Evidence | Status |
| --- | --- | --- | --- |
| D1 | A child cannot start, resume, or cancel a superagent run. | `test/plugin.test.mjs` "a worker session cannot start, resume, or cancel a run" (asks all three tools as the child id the orchestrator remembered) | MET |
| D2 | `maxSubagentDepth: 1` is sent as `maxDepth`; a provider that cannot enforce it makes `superagent_start` fail loudly rather than run unbounded. | unit test + capability table | MET |
| D3 | A second host on the same state directory never rewrites a run owned by a live process, and can cancel it from outside the owning process. | Historical 0.9.0: two-process test + `transcripts/cross-cancel.log` (two real pids, 9/9 checks). 0.25.0 offline 678/678: cross-process queued-cancel marker settles without spawning; live terminal lock is not stolen. | MET (historical host; current regression covered) |
| D4 | Nodes with a stale/dead owner are reclaimed without user action, and the evidence (`reclaimed: …`) is printed. | Historical 0.9.0: unit test + status. 0.25.0 offline 678/678: cleanup keeps a live local terminal lock and removes a dead holder's lock; real host not rerun. | MET (historical; current regression covered) |
| D5 | Cancel of a child that ignores abort returns within the documented bound. | Historical 0.9.0: unit test with a never-settling child. 0.25.0 offline 678/678: cancellation during workspace preparation prevents a later spawn; real host not rerun. | MET (historical; current regression covered) |

## E. Tests

| # | Check, answerable yes/no | Evidence | Status |
| --- | --- | --- | --- |
| E1 | `npm test` passes 5 consecutive full runs with no network and no API key. | Final 0.25.0 command (`node --test --test-concurrency=2 ...`): five consecutive runs, each 747/747 pass, 0 fail; logs `release-closeout/final5-test-1.log` through `final5-test-5.log` | MET |
| E2 | No test depends on `sleep` for correctness; the suite has an event-driven wait helper. | grep for `setTimeout` in assertions | MET |
| E3 | Concurrency, budget, and state-machine changes each got two independent adversarial review rounds with findings recorded. | `docs/PROGRESS.md` 2026-11-25 section: two agent review rounds, findings and fixes for the uncommitted 0.25.0 changes | MET |
| E4 | `lib/usage.js` has direct tests for frames, corrupt data, and missing sessions. | `test/usage.test.mjs` | MET |
| E5 | Reviewer, observability, MCP memory, Host Schedule, and host-workspace extensions have unit/fake coverage, with scoped real-host results for the host-facing paths. | `test/orchestrator.test.mjs`, `test/observability.test.mjs`, `test/mcp-memory.test.mjs`, `test/host-schedule.test.mjs`, `test/workspace-host.test.mjs`, `test/host-integrations.test.mjs`; `docs/e2e-0.25.0.md` Host extensions smoke: Schedule creation `schedule-08a772e7-1618-4b3f-8515-0480659c8ca0`, `sessionQuery`, `tokenPressure: 40`, inactive OTel reporting, workspace ACL failure followed by temporary `danger-full-access` success with cwd restored. No real-host reviewer success is claimed; MCP memory is fake/unit only and no third-party server was started. Full-suite confirmation is recorded under E1 | MET |

## F. Docs tell the truth

| # | Check, answerable yes/no | Evidence | Status |
| --- | --- | --- | --- |
| F1 | Every README claim about host behaviour is exercised by a row above, or explicitly marked as a limitation. | claim table in `docs/e2e-2026-11-14.md` | MET |
| F2 | README states the supported host range and current limits (no forced per-child tool allowlist on `dsh@0.2.2-rc.1`, depth limiting, no remote control plane, no MCP server, no built-in prices), and describes the shipped in-host conversation panel and local workbench instead of claiming no panel/dashboard exists. | README requirements, security, workbench, and known-limitations sections | MET |
| F3 | The README output block is labelled illustrative and links a real transcript; no number is presented as a measurement. | `docs/e2e-2026-11-14.md` | MET |
| F4 | No documented config key is ignored by the code; every top-level `DEFAULTS` key appears in all three README configuration tables. Nested keys are covered by F5 and their dedicated sections. | Automated comparison of the 66 top-level `DEFAULTS` keys against README.md, README.en.md, and README.zh.md: no missing keys | MET |
| F5 | The 0.25.0 Host integrations keys, defaults, aliases, and limits in all three READMEs match the current code and clearly distinguish unit/fake, scoped real-host, and unverified evidence. | README configuration tables and Host integrations sections; static comparison with `lib/index.js` and `lib/mcp-memory.js`; scoped evidence and exclusions in `docs/e2e-0.25.0.md`; Chinese README copies remain identical | MET |

## G. Distribution

| # | Check, answerable yes/no | Evidence | Status |
| --- | --- | --- | --- |
| G1 | `dsh plugin --profile web add @xiangyixie/dsh-superagent` installs the published package name (no `file:`), once the package exists on the registry. | 0.25.0 is not published yet; `plugin-index.json` still ends at 0.24.0. Historical 0.9.0 registry transcript: `docs/e2e/transcripts/g1-install.log`. | PENDING |
| G2 | `npm i -g dsh-superagent` is not offered as an install path (it is a plugin, not a CLI). The `watch`/`report` binaries are operator utilities run from the profile's `node_modules`; the README says they are not the install path. | README "Watch and report" | MET |
| G3 | A stable embedding surface (MCP or local HTTP) lets another UI start/status/cancel runs without importing internals. | `docs/embedding.md` + 17/17 checks against real `dsh@0.2.2-rc.1` in `transcripts/control-plane.log` (start, status, list, cancel, resume, auth, discovery cleanup) + cross-process cancel in `transcripts/cross-cancel.log` | MET |

## H. Release mechanics

| # | Check, answerable yes/no | Evidence | Status |
| --- | --- | --- | --- |
| H1 | Version, CHANGELOG, and README agree on the release version and its date. | `package.json` 0.25.0; `CHANGELOG.md` `## 0.25.0 — 2026-11-25`; all three READMEs pin installs to 0.25.0 | MET |
| H2 | `git status` is clean and the release commit is pushed. | Working tree clean; `fix/superagent-release-closeout` pushed through `df70886` | MET |
| H3 | No known blocker from the latest adversarial review remains open. | Core and extension review findings are fixed with regressions; scoped real-host evidence is under E5 and five consecutive full-suite runs are under E1 | MET |

## I. Operator surfaces

| # | Check, answerable yes/no | Evidence | Status |
| --- | --- | --- | --- |
| I1 | `watch` draws one line per run with id, status, calls used against the cap, elapsed time, current activity, and parent session, and a frame is captured from real runs. | `docs/e2e/transcripts/watch-panel.log` (40 real runs) + `test/watch.test.mjs` | MET |
| I2 | `watch` never strands the terminal: the live path restores the cursor and leaves the alternate screen on Ctrl-C, SIGTERM, and a closed pipe, and `--once` never enters it. | `test/watch.test.mjs` asserts the hide→show ordering on the signal path and a plain, un-hidden frame on the once path; the TTY path was run on the build machine | MET |
| I3 | Neither utility adds a runtime dependency or a published file beyond its own module and binary. | `package.json` `dependencies: {}`; 0.25.0 `npm pack --dry-run`: 77 files; `check-pack`: all 57 entry-reachable files shipped | MET |
| I4 | `report` writes one file that references nothing external: zero `http://`, `https://`, `<script`, `<link`, `src=`, `@import`, `url(`. | `docs/e2e/transcripts/report-cli.log` audit (all zero, 4 inline SVGs) + `test/report.test.mjs` | MET |
| I5 | That file contains a timeline with per-run start/end/phases, concurrency swimlanes, cumulative call and cost curves, and explicit failure/cancellation/interruption annotations. | `docs/report-sample.html` (40 real runs); six section ids asserted by test | MET |
| I6 | Both commands run verbatim from an installed profile, and the README documents exactly that command. | npm-installed tarball: both binaries linked in `node_modules/.bin` and executed against real state (recorded in `docs/PROGRESS.md`); README "Watch and report" | MET |

## Not required for release

- A price for every model. The plugin deliberately ships none.
- A hosted multi-user dashboard or remote control plane. The shipped in-host
  conversation panel, local workbench, watch panel, and static report are local
  operator surfaces, not a hosted service.
- Windows service integration, telemetry, or a hosted control plane.
