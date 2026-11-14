# Definition of done

A release is allowed only when **every** item below is answered "yes" by a
recorded check, not by an opinion. Each item names the evidence that answers it;
evidence lives under `docs/` and is linked from the row.

Status values: `MET` (evidence exists in this repository at this commit),
`PENDING` (no evidence yet), `BLOCKED` (an external dependency — credential,
money, a publish — is missing; the blocker is written in the row).

## A. A stranger can install it

| # | Check, answerable yes/no | Evidence | Status |
| --- | --- | --- | --- |
| A1 | `npm pack` produces a tarball with no test, harness, or credential files. | `npm pack --dry-run` file list | MET |
| A2 | On a `DSH_HOME` that never ran this plugin, `dsh plugin --profile web add dsh-superagent` succeeds with the exact README command. | transcript in `docs/e2e-*.md` | MET |
| A3 | After A2, `dsh --profile web --dump-config` contains the `dsh-superagent` bundle row. | dump excerpt | MET |
| A4 | A fresh session can call all five `superagent_*` tools; none returns "unknown tool". | five scenarios in `docs/e2e-2026-11-14.md` | MET |
| A5 | Every Quickstart command that does not depend on the package being on the registry runs verbatim on a clean home; no undocumented env var or manual edit. | install transcript + claim table in `docs/e2e-2026-11-14.md` | MET |

## B. It works in a real host

Verified against real `dsh@0.2.2-rc.1` with a local stub model (no credential on
the build machine; see B8).

| # | Check, answerable yes/no | Evidence | Status |
| --- | --- | --- | --- |
| B1 | `superagent_start` on a real host produces a plan with ≥2 subtasks and a terminal `completed` run. | `20261114T080127-372d` | MET |
| B2 | At least two subtasks are observed `running` at the same instant (parallelism is real, not sequential). | `transcripts/overlap-trace.jsonl` | MET |
| B3 | The aggregator call happens and `report` is non-empty and contains both subtask findings. | `transcripts/start-status.log` | MET |
| B4 | `superagent_cancel` on a live run returns `cancelled` in ≤10 s and no further child is spawned. | 1.99 s, spawns frozen at 3: `transcripts/cancel.log` | MET |
| B5 | After the host process disappears mid-run, the next host reports `interrupted`; `superagent_resume` completes only the unfinished subtasks (completed ones keep their original `childId`). | `transcripts/kill-and-resume.log` | MET |
| B6 | `notify` wakes a live session when nobody polls. | `notify.delivered: true` on `20261114T075657-b729` | MET |
| B7 | A headless host that exits before the run finishes records `notify.delivered: false` with the reason, and status prints it. | run `20261114T074822-6059` | MET |
| B8 | The same paths are exercised with the default `deepseek-official` route and a real key, with the real cost printed. | `docs/e2e-paid-*.md` | BLOCKED: no `DEEPSEEK_API_KEY` on the build machine; a real-model run cannot be produced without spending the owner's credential. |

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

| # | Check, answerable yes/no | Evidence | Status |
| --- | --- | --- | --- |
| D1 | A child cannot start or resume a superagent run. | `transcripts/child-attempt.log` | MET |
| D2 | `maxSubagentDepth: 1` is sent as `maxDepth`; a provider that cannot enforce it makes `superagent_start` fail loudly rather than run unbounded. | unit test + capability table | MET |
| D3 | A second host on the same state directory never rewrites a run owned by a live process. | two-process test | MET |
| D4 | Nodes with a stale/dead owner are reclaimed without user action, and the evidence (`reclaimed: …`) is printed. | unit test + status | MET |
| D5 | Cancel of a child that ignores abort returns within the documented bound. | unit test with a never-settling child | MET |

## E. Tests

| # | Check, answerable yes/no | Evidence | Status |
| --- | --- | --- | --- |
| E1 | `npm test` passes 5 consecutive full runs with no network and no API key. | five command exits in `docs/PROGRESS.md` | MET |
| E2 | No test depends on `sleep` for correctness; the suite has an event-driven wait helper. | grep for `setTimeout` in assertions | MET |
| E3 | Concurrency, budget, and state-machine changes each got two independent adversarial review rounds with findings recorded. | `docs/PROGRESS.md` review sections | MET |
| E4 | `lib/usage.js` has direct tests for frames, corrupt data, and missing sessions. | `test/usage.test.mjs` | MET |

## F. Docs tell the truth

| # | Check, answerable yes/no | Evidence | Status |
| --- | --- | --- | --- |
| F1 | Every README claim about host behaviour is exercised by a row above, or explicitly marked as a limitation. | claim table in `docs/e2e-2026-11-14.md` | MET |
| F2 | README states what the plugin cannot do on `dsh@0.2.2-rc.1` (no tool allowlist, no nested delegation, no panel, no remote control plane, no MCP server) and what it does not ship (no built-in prices). | README sections | MET |
| F3 | The README output block is labelled illustrative and links a real transcript; no number is presented as a measurement. | `docs/e2e-2026-11-14.md` | MET |
| F4 | No documented config key is ignored by the code; every `DEFAULTS` key appears in the README table and vice versa. | 18 keys, exact match | MET |

## G. Distribution

| # | Check, answerable yes/no | Evidence | Status |
| --- | --- | --- | --- |
| G1 | `dsh plugin --profile web add dsh-superagent` installs the published package name (no `file:`), once the package exists on the registry. | post-publish transcript | BLOCKED: not published, by instruction |
| G2 | `npm i -g dsh-superagent` is not offered as an install path (it is a plugin, not a CLI). | README | MET |
| G3 | A stable embedding surface (MCP or local HTTP) lets another UI start/status/cancel runs without importing internals. | `docs/embedding.md` + 17/17 checks against real `dsh@0.2.2-rc.1` in `transcripts/control-plane.log` (start, status, list, cancel, resume, auth, discovery cleanup) | MET |

## H. Release mechanics

| # | Check, answerable yes/no | Evidence | Status |
| --- | --- | --- | --- |
| H1 | Version, CHANGELOG, and README agree on the release version and its date. | files | PENDING |
| H2 | `git status` is clean and the release commit is pushed. | `git log`/`git status` | PENDING |
| H3 | No known blocker from the latest adversarial review remains open. | review list in `docs/PROGRESS.md` | PENDING |

## Not required for release

- A price for every model. The plugin deliberately ships none.
- A GUI panel. The position is engine, not product.
- Windows service integration, telemetry, or a hosted control plane.
