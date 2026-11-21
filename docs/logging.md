# Logging

One structured log for the whole server, readable by humans (Output panel, `/api/logs`) and by agents
(`webterm logs.summary`, `webterm logs.query`).

## Entry

JSON lines in `<dataDir>/logs/webterm-YYYY-MM-DD.log` and a ring buffer in memory (`WEBTERM_LOG_BUFFER`):

```json
{"seq":1,"ts":1760000000000,"level":"warn","source":"server","channel":"browser.ssrf",
 "event":"browser.ssrf.block","message":"blocked outbound connection",
 "ids":{"nodeId":"n1"},"data":{"hostname":"10.0.0.5","reason":"private"}}
```

- `channel`: owning subsystem (`pty`, `api`, `browser.page`, ...). A parent matches its children.
- `event`: `domain.subdomain_action`, lowercase, digits and `_` only (`browser.page_net_error`).
  `src/server/logs/logEvents.policy.test.ts` scans server sources; a new event that does not match fails,
  and the old exceptions are an explicit named list in that test (shrink it, never grow it).
- Correlation ids go in `ids`, never in the message: `nodeId`, `workspaceId`, `profileId`, `requestId`, `sessionId`.
- Every entry passes `logSanitize.ts`: secrets masked, strings and depth capped. Do not log PII or page content.

## Channels worth knowing

| Channel | What |
|---|---|
| `browser.page` | Errors, warnings, failed requests and exceptions of a browser node page, deduplicated (see below) |
| `browser.ssrf` | The outbound proxy blocking or failing a connection (`browser.ssrf.block`, `.dns_fail`, `.upstream_error`) |
| `browser.launch` | Chromium start/stop problems |

### `browser.page`

Bridged from the page console by `src/server/browser/browserHost.console.log.ts`. Only error/warning level,
network failures and exceptions. URLs are `scheme://host/path` (no query, no fragment); messages are cut at 300
characters; no stacks, no arguments. A failure group (kind, category, host, status) is logged once, then again at
5, 25, 125... occurrences with `data.count`, `data.firstTs`, `data.lastTs`. At most 20 entries per second per node.
Failures caused by the built-in ad/tracker blocker (`ERR_BLOCKED_BY_CLIENT`, and `ERR_FAILED` / CORS console errors for URLs the filter engine blocks) are logged at `debug` and do not count toward the 20 per second.

## Retention

Daily files, rotated at 5 MiB. Files older than `WEBTERM_LOG_RETENTION_DAYS` (14) are deleted and the oldest go
first when the directory exceeds `WEBTERM_LOG_MAX_MB` (200); at boot and every 24 hours, one `logs.purged`
event per run that removed something. `GET /api/logs/stats` returns file count, bytes, span and the policy.

## Agents

A chat node with the `maintainer` preset also has `doctor.run`, `config.read` and `instance.info` (docs/decisions/maintainer-agent.md).

Rule: **an agent never asks the user for a screenshot or a copy of an error. Run `logs.summary` first.**

```sh
webterm logs.summary --json '{"since":"10m"}'                 # why did it fail? (add "node":"<browser node id>")
webterm logs.query --json '{"channel":"browser.page","since":"10m","limit":50}'
webterm logs.query --json '{"event":"browser.ssrf","level":"warn"}'
```

`logs.summary` returns level/channel counts, `pageFailures` (per category, host and status, with `count`, first and
last time and a `hint`), `serverEvents` (`browser.ssrf.*`, `browser.launch*` of the same window) and `diagnosis`
(the hints, most frequent first). Hints live in one table, `src/server/logs/logHints.ts`.

`logs.query` filters: `channel`, `level`, `since` (`90s`, `10m`, `2h`, `1d`), `node`, `event` (name or prefix),
`q`, `limit` (max 200). Output is capped at 200 rows and 64 KB.

Visibility for an agent: warn/error of every channel; every level for its own node and the nodes wired to it;
never the channels `auth`, credentials, secrets, tokens, cookies, accounts. Every row is scrubbed again on the
way out (URL query strings, tokens, headers). Both capabilities are tier R0, no approval; they read the in-memory
buffer (`WEBTERM_LOG_BUFFER` entries), not the files. The capabilities are declared in
`src/server/capability/logs.capabilities.ts`; the CLI guide, `agent-context` and the parity tests derive from it.
