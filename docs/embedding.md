# Embedding: the local HTTP control plane

The five tools only exist inside a host session. A dashboard, an editor panel,
a CI script, or another agent runtime cannot call them without importing this
package's internals **and** holding a live agent object.

`controlPort` closes that gap: the plugin can expose the same five operations
over loopback HTTP, so an embedder needs nothing but an HTTP client and the
discovery file the plugin writes.

This page is the contract. It is backed by an offline suite
(`test/control.test.mjs`) and a real-host run
([transcripts/control-plane.log](e2e/transcripts/control-plane.log), 17 checks,
official `dsh@0.2.2-rc.1`).

---

## 1. Turn it on

Off by default. A plugin must not open a socket because it was installed.

```yaml
# <profile>/cordis.patch.yml
- id: superagent
  config:
    controlPort: 0     # 0 = OS picks a free port; or a fixed port such as 7331
```

- `null` / absent — no socket, no discovery file, no effect on the host.
- `0` — ephemeral port; preferable when several hosts or profiles may run at once.
- `1–65535` — fixed port. If it is taken, the host logs why and continues
  without the control plane; the tools keep working.
- Any other value (including `"abc"`) is refused with a log line and the socket
  stays closed. A malformed port never becomes an accidental listener.

The server binds `127.0.0.1` only. There is no configuration to bind a routable
interface, on purpose.

## 2. Find it

After the socket is listening, the plugin writes `<stateDir>/control.json` with
mode `0600`:

```json
{
  "service": "dsh-superagent",
  "version": "0.9.0",
  "url": "http://127.0.0.1:62460",
  "token": "…43 characters…",
  "pid": 34728,
  "instanceId": "6f1c0a9d2b3e",
  "hostname": "…",
  "stateDir": "…\\state\\superagent",
  "startedAt": "2026-11-14T08:26:25.000Z"
}
```

- The token is regenerated on every host start. Read it from this file; never
  hardcode it.
- `pid` lets an embedder check that the process is still alive before calling.
  `instanceId` identifies the plane inside that process (a host can reload the
  plugin without changing its pid); clients do not need it.
- The file is removed when the host shuts down cleanly. If a host is killed, a
  stale file remains; check `pid`, then delete it.
- **It is UTF-8 without a BOM**, as JSON must be. Windows PowerShell 5.1 reads
  files as ANSI by default and will garble a non-ASCII hostname, so use
  `Get-Content -Encoding UTF8` (or `[System.IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)`)
  instead of a bare `Get-Content`.

## 3. Authenticate

Every request needs the token:

```
Authorization: Bearer <token>
```

There is no anonymous endpoint, including `/health`: an unauthenticated surface
would let any local process enumerate goals and reports.

## 4. Endpoints

All responses are JSON with this envelope:

```json
{ "ok": true,  "data": { … }, "text": "the same text the tool would print" }
{ "ok": false, "error": { "id": "unauthorized", "summary": "…", "hint": "…", "detail": "…" } }
```

`text` is produced by the same formatter as the tool results, so an embedder can
show it verbatim without reimplementing the layout. The one difference is the
closing next-step line on a background start: the tool says "poll with
`superagent_status`", the HTTP reply names `GET /runs/:id`. The run block above
it is identical. `GET /` and `GET /health` are the two replies without `text`:
they describe the socket, not a run.

### `GET /`

Route index, useful as a reachability probe:

```json
{"ok":true,"data":{"service":"dsh-superagent","version":"0.9.0","pid":34728,
 "endpoints":["GET /health","GET /runs","GET /runs/:id","POST /runs",
              "POST /runs/:id/cancel","POST /runs/:id/resume"]}}
```

### `GET /health`

```json
{"ok":true,"data":{"service":"dsh-superagent","version":"0.9.0","pid":34728,
 "hostname":"…","stateDir":"…","startedAt":"…","uptimeSeconds":3,"runs":"GET /runs"}}
```

Liveness only: a probe must not reclaim runs or sweep the state directory, so
this endpoint does no state work. Ask `GET /runs` what is running.

### `GET /runs?limit=20`

Newest first. `limit` is clamped to 1–100; the default is 20.

```json
{"ok":true,"data":{"runs":[{ "id":"20261114T082625-d8c8", "status":"completed", … }],
 "stats":{"files":3,"bytes":18422,"corrupt":0,"root":"…"}},"text":"…"}
```

Each entry is the stored run object (`schemaVersion: 1`), not a reduced view.

### `GET /runs/:id?wait=30`

One run. `wait` blocks up to 300 s for a terminal state and is clamped. Use
`wait=0` (the default) for a snapshot; polling callers can long-poll instead.

```json
{"ok":true,"data":{"run":{"id":"20261114T082625-d8c8","status":"completed",
 "goal":"…","parentSessionId":"session-…","usage":{…},"cost":{…},"report":"…"}},
 "text":"run 20261114T082625-d8c8 — completed\n…"}
```

### `POST /runs`

Starts a run. **`session_id` is required** and must name a session that is open
in the host process that owns this control plane.

```json
{"goal":"Compare two sorting strategies on the fixture.",
 "session_id":"session-3696f9df-048c-433a-a188-8609ec899260",
 "max_subtasks":4, "max_parallel":2, "deadline_minutes":30,
 "wait_seconds":0}
```

- Only `goal` + `session_id` are required; the rest are optional overrides of
  the run's limits. A blank `goal` answers 400 `no-goal` even when `session_id`
  is also missing, so the first error names the first thing to fix.
- Replies `202` with the run. With `wait_seconds > 0` the reply is the finished
  run instead of a snapshot (capped at 300 s).
- The run is a normal run: same quota, same budgets, same notify rules, same
  cancellation, same recovery. Nothing about the transport loosens a check.
- A run must be owned by a live session because the host creates its children
  through that agent. There is no synthetic parent and no "orphan" mode; a
  missing session is refused as `no-session` rather than started in a state
  nothing can cancel or resume.

**Where does `session_id` come from?** It is the id of a session that is open
in the host — the same value that appears as `parentSessionId` on any run
started from that session. Root session directories are named
`session-<uuid>` under `$DSH_HOME/sessions/<workspace>/`, so
`session-<uuid>` is the id; child sessions use the bare uuid and are refused by
the recursion guard. The plugin does not expose a session list, because the
host owns that registry; if you need one, read the newest directory under that
sessions path.

`wait` is capped at 300 s **on this transport**, while `superagent_status`
accepts longer waits. A long HTTP poll holds one connection; the server allows
64.

### `POST /runs/:id/cancel`

Same semantics as `superagent_cancel`, including cross-process cooperative
cancel. A terminal run answers `nothing to cancel` instead of pretending.

### `POST /runs/:id/resume`

```json
{"session_id":"session-…", "wait_seconds":0}
```

Continues an `interrupted`, `failed`, `partial`, or `cancelled` run and replies
`202` with it. It takes the same run lock as the tool path and may only be called
by a session that is live in this host and is the run's `parentSessionId`;
anything else is `409 wrong-session`. A resume does not count against
`maxActiveRuns`, so a full cap never refuses it; `"force"` and
`"override_quota"` are still accepted and ignored.

## 5. Errors

Transport refusals carry their own ids, so a caller can tell "my token is wrong"
from "the run is broken":

| Status | `error.id` | Meaning |
| --- | --- | --- |
| 400 | `bad-json` | Body is not a JSON object. |
| 400 | `bad-run-id` | Empty run id in the path. |
| 400 | `aborted` | The client closed the connection while sending the request. |
| 400 | `no-goal` | `goal` is missing or blank. Same classification the tool's text uses. |
| 401 | `unauthorized` | Missing or wrong bearer token. The hint names the discovery file. |
| 403 | `forbidden-host` | `Host` header is not `127.0.0.1` / `localhost`. Blocks DNS rebinding. |
| 404 | `not-found` | No such route. |
| 404 | `unknown-run` | No run with that id in this state directory. |
| 405 | `method-not-allowed` | Wrong verb for the route. |
| 409 | `no-session` | `session_id` is missing or not open in this host. |
| 409 | `recursion` | `session_id` names a superagent worker; workers may not start or resume runs. |
| 409 | `run-owned` | Another live process is running it. |
| 409 | `wrong-session` | `session_id` is not the run's `parentSessionId`. |
| 409 | `quota` | `maxActiveRuns` is full. Only `POST /runs` (a start) produces this; a resume is never refused by the cap. |
| 409 | `budget` | The run hit a spending cap. |
| 413 | `body-too-large` | Body over 64 KB. |
| 500 | `corrupt`, `unclassified`, … | Classified by `lib/errors.js`, same text as the tools. A damaged run file is ours to fix, not the caller's. |
| 503 | `not-ready` | Request arrived before the socket finished binding. |
| 503 | `no-subagents` | This profile has no subagent service, so no run can start. Enable it and restart the host. |

## 6. Security model

- **Loopback only.** Bound to `127.0.0.1`; no option to expose it.
- **Token per process.** 32 random bytes, base64url, constant-time compared.
  Written to a `0600` file in the state directory, and nowhere else. On POSIX
  that mode is enforced; on Windows `mode` is advisory and the state
  directory's ACL decides who can read it — which is the same boundary that
  already lets a process read and write run files.
- **Host header check.** A rebinding page that resolves its own domain to
  `127.0.0.1` sends its own `Host` and is refused with 403.
- **No CORS headers.** A page on another origin cannot read replies, and a
  cross-origin request with an `Authorization` header needs a preflight this
  server never grants.
- **Bounded input.** 64 KB bodies; a 60 s timeout for *sending* a request
  (long polls produce their response after that, which is why the 300 s wait
  still works); 64 concurrent connections.
- **No new dependencies.** `node:http` only, so there is no third-party code in
  the request path.
- **Opt-in.** The socket only exists when `controlPort` is set.

A local process running as the same user can read the token; so can any process
that can read the state directory. That is the trust boundary, and it is the
same boundary that already allows writing run files.

## 7. Client examples

### curl

```bash
STATE="${DSH_HOME:-$HOME/.dsh}/state/superagent"
URL=$(node -e "console.log(require('$STATE/control.json').url)")
TOKEN=$(node -e "console.log(require('$STATE/control.json').token)")

curl -s -H "Authorization: Bearer $TOKEN" "$URL/runs"

curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"goal":"Compare two sorting strategies.","session_id":"session-…"}' \
  "$URL/runs"
```

### PowerShell

```powershell
$home_ = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$d = Get-Content "$home_\state\superagent\control.json" -Raw -Encoding UTF8 | ConvertFrom-Json
$h = @{ Authorization = "Bearer $($d.token)" }

Invoke-RestMethod "$($d.url)/runs" -Headers $h
Invoke-RestMethod "$($d.url)/runs" -Method Post -Headers $h -ContentType 'application/json' `
  -Body (@{ goal = 'Compare two sorting strategies.'; session_id = 'session-…' } | ConvertTo-Json)
```

### Node

```js
const discovery = JSON.parse(await readFile(`${process.env.DSH_HOME}/state/superagent/control.json`, 'utf8'))
const response = await fetch(`${discovery.url}/runs`, {
  headers: { authorization: `Bearer ${discovery.token}` },
})
console.log(await response.json())
```

## 8. Lifecycle

- The server starts at mount, once the state directory exists, and stops when
  the plugin is disposed (host shutdown or profile unload).
- A dispose that lands while the port is still binding waits for the start to
  settle and closes it; a start that sees the stop request closes itself before
  publishing a discovery file. Mounting and immediately shutting down never
  leaves an orphaned listener.
- On stop, the listening socket is closed and `control.json` is removed **only
  if it still names this process**. A second host that took over the file is not
  left with a dangling discovery entry.
- Two hosts may share one state directory. Each writes its own discovery file;
  the later one wins. Both see the same runs through the filesystem, and the
  existing ownership/lock rules keep them from running the same run twice.
- A run started over HTTP keeps running if the HTTP client disconnects. Only the
  host process (or `cancel`) stops it.

## 9. Versioning

`data` currently carries `schemaVersion: 1` on each run. The rules:

- New optional fields may be added within `schemaVersion: 1`.
- Removing a field, changing its type or meaning, or changing an endpoint's
  method/path bumps `schemaVersion` and is announced in `CHANGELOG.md`.
- `GET /` reports the plugin `version`, so a client can gate on it.

## 10. Non-goals

- No MCP server. MCP would be a second transport with the same operations; the
  HTTP surface is smaller and needs no extra process.
- No remote access, TLS, or multi-user auth. Run a reverse proxy if you need
  that; the plugin is not a service.
- No file upload or report streaming. Reports are text inside the run object,
  capped by `resultCapBytes`.
- No event stream. Use `wait` on `GET /runs/:id`, or poll `GET /runs`.
