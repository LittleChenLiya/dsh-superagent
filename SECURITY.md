# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on
<https://github.com/LittleChenLiya/dsh-superagent/security/advisories/new>, or
open an issue that describes the impact without a working exploit and ask for a
private channel.

Please do not open a public issue with a reproduction that lets someone else
take over a host.

## What this plugin can reach

- It runs inside a DSH host process, so it can read and write the host's state
  directory (`$DSH_HOME/state/superagent` by default) and start child agents
  through the host's subagent service. It never reads API keys: the host's model
  route owns credentials.
- The optional local HTTP control plane (`controlPort`) binds `127.0.0.1` only,
  requires a per-process bearer token, checks the `Host` header, sends no CORS
  headers, and caps bodies and connection counts. The token is stored in
  `<stateDir>/control.json`; on Windows the file mode is advisory and the
  directory ACL is the real boundary. Treat "can read the state directory" as
  "can control the runs".
- There are no runtime dependencies, so the request path contains only
  `node:http` and this package.

## Supported versions

The latest published minor version. Fixes are released as a new version; this
project does not backport.
