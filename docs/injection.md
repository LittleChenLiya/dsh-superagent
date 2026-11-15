# Live injection into a running child

Question: can `dsh-superagent` put a message into a child activation that is
already running, and how late is it?

Answer: yes on `dsh@0.2.2-rc.1`. The delay is bounded by the child's current
step, not by the plugin. Measured on the real host: **2986 ms** with a 4 s child
step and **6978 ms** with an 8 s step.

## 1. Host evidence

Read on 2026-11-15 under
`D:\Codex\.cache\npm\_npx\72500ffcd8799faa\node_modules\@deepseek-ai\`
(the `@deepseek-ai/dsh@0.2.2-rc.1` install, Node 24):

| File | What it establishes |
| --- | --- |
| `dsh-agent/lib/types/runtime-types.d.ts` | `Agent` has four input methods. `send(message, target, wakeup)`, `followup(message)` (own later turn), `steer(message)` ("Submit steering for the nearest step. An idle driver starts a turn; a running driver consumes it at its next step boundary"), and `inject(message)` (model-facing context, does not wake). `Agent.inbox` exposes `nextStep` / `nextTurn`. |
| `dsh-agent-loop/lib/index.js` | The turn loop claims the inbox at `preStep`, before building the model request. After `turn/end`, a non-empty `nextStep` starts another turn instead of closing — so a live, uncancelled child always consumes steering. |
| `dsh-subagent/lib/types/index.d.ts` | `subagents.sendMessage(sender, targetId, content, { signal })` — documented "steer between adjacent local Agents"; also `prompt({ …, delivery: 'steer' \| 'queue' })` for continuable children. |
| `dsh-subagent/lib/types/manager.js` | `sendMessage` validates that `sender` is the exact live adjacent agent, then `deliverToChild` with `delivery: 'steer'` calls `local.handle.agent.steer(message)`. It throws if the activation is closing or its input is closed. |
| `dsh-subagent-spawn-in-process/lib/index.js` | The `spawn` provider implements `prepareContinuable`, and `startActivation` materialises a local continuable child — the provider this plugin uses. |

CLI check: `dsh` has no `--session-id` resume flag in this build; the live
channel is in-process only. Another process can read runs, but it cannot reach
these inboxes, which is why `superagent_inject` refuses a run owned elsewhere.

## 2. Implementation

`lib/inject.js` and `lib/orchestrator.js` (`inject`, `waitForInjection`).

1. Targets are the run's `subtasks` with `status: 'running'` and a `childId`
   (optionally narrowed by `subtask_index`). No running worker is an error that
   points at `superagent_followup`; nothing is silently queued.
2. Delivery prefers `subagents.sendMessage(parent, childId, [{type:'text',text}])`.
   If that method is absent, it falls back to `agent.steer({ id, role:'user', content, source })`
   on the live child. If neither exists it throws `inject-unsupported`.
3. The receipt is stored on the run under `injections[]` (separate from
   `followups[]`): `messageId`, `via`, `acceptedAt`, then `status`
   (`pending` → `applied` | `missed` | `failed`), `appliedAt`, `latencyMs`, or
   `missedAt` + `missedReason`.
4. A watcher polls the child's `inbox.nextStep` / `inbox.nextTurn` every
   `injectPollMs` (default 25 ms). The message disappearing is the claim: the
   pre-step removed it to build the next model request. `latencyMs` is measured
   at that moment, so every reported number has a 25 ms resolution — it is
   printed with the number, not hidden.
5. Before a child is disposed, `settleChildInjections` reads the inbox one last
   time: still there means `missed` ("the child finished its turn before the
   instruction reached another step boundary"); absent means `applied`. A run
   that settles first marks every remaining receipt `missed`. So a lost message
   is always reported as lost.

`superagent_followup` and `superagent_answer` keep their exact next-boundary
semantics: their code paths were not touched, injections live in a separate
trail, and a live injection does not add a followup entry.

## 3. Measured latency (real host, stubbed model)

Harness: `docs/e2e/stub-llm` extended with an `inject` scenario. Worker Alpha
holds its first model step open for `E2E_INJECT_STEP_MS`, then takes a tool step
so a second pre-step exists. The parent issues `superagent_inject` mid-step with
`wait_seconds: 15`.

Run on a fresh `DSH_HOME`, plugin installed from `npm pack`:

```text
node <dsh>/lib/bin.js --profile headless "[e2e:inject] …"
```

| Child step length | Inject issued at | Measured acceptance → child's next step | Tool wall | Child result |
| --- | --- | --- | --- | --- |
| 4 s | ~1.2 s into the step | **2986 ms** | 3080 ms | `ALPHA-REPORT: … INJECT-SEEN: yes` |
| 8 s | ~1.2 s into the step | **6978 ms** | 7034 ms | `ALPHA-REPORT: … INJECT-SEEN: yes` |

`INJECT-SEEN: yes` is the worker's own final answer: the injected text was in
its second model request's messages, not merely in an inbox. Run state shows
`status: applied`, `via: subagents.sendMessage`, `latencyMs: 2986` / `6978`.
Transcripts: [transcripts/inject.log](e2e/transcripts/inject.log),
[transcripts/inject-long-step.log](e2e/transcripts/inject-long-step.log).

Worst-case statement, no rounding up:

- The bound is the remainder of the step that is executing — one model
  response plus its tool batch. The two measurements above track that bound
  (≈4 s step → ≈3 s remaining; ≈8 s step → ≈7 s remaining).
- If the child is between steps and idle but alive, the steer wakes it and the
  delay is one poll period plus the host's scheduling (tens of ms).
- If the child is cancelled, disposed, or finishes before another pre-step, the
  message is **not** delivered; the receipt is marked `missed` with a reason.

## 4. Degradation when the host has no live channel

If neither `subagents.sendMessage` nor `Agent.steer` exists, every target fails
with `inject-unsupported`. The tool does not pretend: it queues the instruction
exactly where `superagent_followup` would put it, marks the injection receipt
`degraded` with the followup id, and the reply says the message was queued, that
it takes effect at the next prompt boundary, and that a worker already running
does not see it. Status prints the same. The followup's own semantics are
unchanged.

## 5. Tests

`test/inject.test.mjs` covers:

- accepted → claimed at the next boundary, with a measured `latencyMs` and the
  followup queue left empty;
- accepted → never claimed → `missed` at child settle with a reason, not
  "delivered";
- `inject-unsupported` → degraded to the next-prompt queue, visible in the
  receipt and the reply;
- `subagents.sendMessage` preferred over `Agent.steer`, with a usable
  `AbortSignal` in both cases;
- a departed child refused with `inject-child-gone`.

Full suite: `npm test` → **173 tests, 173 pass, 0 fail** (168 before this
feature).
