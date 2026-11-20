# Credential proxy: Claude children never hold the real key

Status: design (breaking changes allowed: the project is in DEV, no compatibility, data migration or old-session support).

## Problem

webterm sets `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` on every `claude` process that carries a credential
(`agentEnv.ts` `providerEnvFrom`, `claudeProvider.model.ts` `providerEnv`). On Linux Claude Code then
requires `bubblewrap` (+`socat`). In a locked container (cap_drop ALL, no-new-privileges) `bwrap` cannot
create mount/uid namespaces, so every credentialed Claude session in Docker fails to start. Turning the
scrub off or loosening the container are patches and are rejected. Proven PoC (orchestrator, office container):
`claude` with `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` + `ANTHROPIC_API_KEY=<placeholder>` through a local
Bun proxy that swaps the auth header and streams the body works for `-p` and the Bash tool without bwrap/SCRUB.

Decision: a loopback **credential proxy** inside the webterm server holds the only copy of the real
credential. Every Claude child gets `ANTHROPIC_BASE_URL=<proxy>` and a placeholder in `ANTHROPIC_API_KEY`.
No SCRUB is set, because there is nothing to scrub.

## 1. Launch paths (verified in code)

Every Claude process is built from one of two env composers, both ending in
`claudeProvider.store.ts` (`activeProviderEnv` / `claudeEnv`) or `agentEnv.ts` (`providerEnvFrom`):

| Path | Where the env is built | Today |
|---|---|---|
| Terminal agent PTY (tmux or direct) | `sessions.ts` `open`: `wrapClaudeLaunch(cmd, activeProviderEnv(), shell)` writes a one-shot 0600 `launch/*.sh` that `unset`/`export`s the provider env then `exec`s the command; `ptyEnv(process.env)` gives the base | real key + SCRUB |
| tmux server itself | `ptySupervisor.ts` `TmuxSupervisor.env` = `ptyEnv(process.env)`; the first tmux call becomes the server and **every pane inherits its env** | server-env `ANTHROPIC_*` leaks to all panes (PROVIDER_KEEP in `dotenvFiles.ts`) |
| Agent chat (SDK child) | `agentChat/agentChat.env.ts` `agentChatEnv`: `applyProviderEnv(ptyEnv(parent), activeProviderEnv())` | real key + SCRUB |
| Central runtime (SDK child) | `central/runtime/claudeRuntime.ts:259` `claudeEnv({...claudeChildEnv(env), ...cacheEnv})`; `claudeOptions.ts` `claudeChildEnv` (allowlist + `providerEnvFrom(parent)`) | same |
| Headless exec | `spawn/agentSpawn.ts:144` `providerEnvOf()` -> overrides into `central/agents/execRunner.ts` `scrubExecEnv` -> `agentEnv.ts` `scrubAgentEnv` -> `providerEnvFrom` | same |
| Helper `claude -p` | `central/context/claudeStructured.ts:103`, `central/health/healthAnalyze.ts:73` (`claudeEnv(claudeChildEnv(...))`), `nameGen.ts` `cleanEnv` (`claudeEnv(childEnv())`) | same |
| Connection test | `claudeProvider.connectionStream.ts:83` `claudeEnv(claudeChildEnv(...))` -> `connectionTest.ts` `requestArgv`; probe `claudeLaunch.probe.ts` `spawnRun` (version/`auth status`, env from the same composer) | same |
| Model/connectivity readers (no spawn) | `models/modelRequest.ts`, `conversationModelChoice.ts` (model vars only); `connectivity/connectivity.runtime.ts:28` reads `claudeEnv(process.env).ANTHROPIC_BASE_URL` to ping the endpoint | must keep the REAL upstream URL (see 6) |
| Profile argv only (no env built) | `claudeLauncher/*`, `claudeSdkSpawn.ts`, `templates/template.instantiate.ts`, `canvas.act.defs.ts`, `routes/agentChat.routes.ts` | not read line by line; the scanner test (6) proves it |

Decision: collapse all of this onto ONE composer (`credentialProxy.env.ts`, below). Everything above
that reads a credential today either calls it or, for the tmux server and PTY base env, has the credential
vars stripped in `ptyEnv`. Rejected: patching each path (that is how the tmux-server leak survived).

## 2. Modes

| Mode | Decision | Reason |
|---|---|---|
| Card `apiKey` (upstream `https://api.anthropic.com`) | proxied, upstream header `x-api-key` | official API keys are only valid as `x-api-key` |
| Card `custom` + `credential=authToken` | proxied, upstream `Authorization: Bearer` | gateway contract |
| Card `custom` + `credential=apiKey` | proxied, upstream `x-api-key` | gateway contract |
| Server env `ANTHROPIC_API_KEY`/`AUTH_TOKEN`/`BASE_URL`/`CUSTOM_HEADERS` while the card is `login` | proxied: the proxy treats them as the upstream (card wins when saved) | today they are forwarded raw; the only other option is leaking them |
| `ANTHROPIC_CUSTOM_HEADERS` | applied by the proxy on the upstream request, removed from the child env | it carries gateway credentials; the model has no use for it |
| `login` (OAuth in `~/.claude`) | NOT proxied; no env change, no SCRUB (already true) | credential is a file the CLI refreshes itself, the OAuth refresh and subscription endpoints are not a plain API-key swap; proxying them is a different, riskier project |
| `command` (launch profile wrapper, e.g. `envman -- claude`) | NOT proxied; webterm sets no credential, no SCRUB (already true: `providerEnv` returns `{}`) | the wrapper injects its own credential after webterm; we do not own it |
| `CLAUDE_CODE_OAUTH_TOKEN` in server env | out of scope, still passes through `ptyEnv` | OAuth bearer for the subscription endpoint, not API-key shaped. Listed as an explicit exception in the policy test with this reason |

Placeholder variable: always `ANTHROPIC_API_KEY` (one path, one test). `ANTHROPIC_AUTH_TOKEN` and
`ANTHROPIC_CUSTOM_HEADERS` are unset in the child, as the model's unset list already clears everything outranking the card.
`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is also in the unset list, so a value inherited from the server env cannot bring bwrap back.
The model/tier vars (`ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_*`) stay in the child env: they are not secrets.
Children are also given `NO_PROXY=127.0.0.1` appended to any inherited value, so a container-level `HTTP(S)_PROXY`
does not route loopback through an egress proxy (belum diverifikasi: reproduce with `HTTPS_PROXY=http://x:1` in the container and run `claude -p`).

## 3. Lifecycle (the main problem)

Verified: `ptySupervisor.ts` runs sessions in a tmux server (`-L webterm`) that outlives Bun; `Sessions.open`
re-attaches to a live session and ignores `cmd`/`env` ("hanya berlaku saat create"); `adoptSupervised` runs at boot.
So a pane's `claude` keeps the `ANTHROPIC_BASE_URL` it was created with for its whole life, while the proxy dies with the server.

| Option | Verdict |
|---|---|
| **A. Fixed port + fixed token persisted in the data dir; the server re-binds it at boot, before any session is adopted or spawned** | **Chosen** |
| B. Proxy in a long-lived supervisor process | Rejected. The supervisor is stock tmux, there is no webterm code in it. A new daemon means a second process lifecycle, socket ownership, version skew and a place to hold the real key outside the server; the same class of complexity `ptySupervisor.ts` avoided by not copying Orca's daemon. |
| C. Unix socket | Rejected. `ANTHROPIC_BASE_URL` is an http(s) URL; Claude Code has no documented unix-socket endpoint (belum diverifikasi: grep the CLI docs / try `http+unix://`). A socket path also adds sun_path limits (CLAUDE.md macOS note). |
| D. New port per boot | Rejected. Breaks every live pane on each restart. |

Mechanics:
- State: `<dataDir>/credential-proxy/` via `createFileSecretStore` (0600 files, dir is already in the agent sandbox deny list): keys `TOKEN` (random 32 bytes base64url, created once, never rotated automatically: rotation = restart every session) and `PORT`.
- Boot (`credentialProxy.lifecycle.ts` `startCredentialProxy`): bind `127.0.0.1:<stored PORT>`; first run binds port 0 and stores what the OS chose (ephemeral range, no collisions with `PORT=8700`). Called from `server.main.ts` before `sessions` exist, so adoption never races a dead URL.
- Port taken at boot (`EADDRINUSE`): bind port 0, store the new port, log `credential_proxy.port_changed` at warn, and publish a UI notice "N running agent sessions point at the old proxy address and need a restart". Sessions whose pane env has the old port fail with a clear connection error until restarted. No silent fallback to a real key, ever.
- Server down briefly: Bash tool and the TUI keep running (tmux pane is alive); model requests get `ECONNREFUSED`. webterm already sets `CLAUDE_CODE_RETRY_WATCHDOG=1` for agent sessions (retries transient errors up to ~3 h per the agentEnv comment), so a restart of seconds should be invisible. Whether `ECONNREFUSED` counts as transient for the watchdog is belum diverifikasi: start a session, `kill` the server for 20 s mid-turn, restart, check the turn completes (done criterion 4 in 7).
- Live reconfiguration (side effect, accepted): the proxy reads the card/secret per request, so rotating the real key or switching the card applies to running sessions immediately; switching the card to `login`/`command` makes the proxy answer 503 `no_upstream` to old panes. The existing "started before the change" restart hint (`claudeSessionsStartedBefore`) stays for model vars.
- Native host (`src/native`) imports the same module in-process: same start/stop hooks (`stopServer` in `server.main.ts`).

## 4. Proxy security

Server: `Bun.serve({ hostname: '127.0.0.1', port, idleTimeout: 0 (no cut of long SSE; verify the value Bun accepts: belum diverifikasi, check in the unit test with a 5 s silent stream) })`.

| Threat | Mitigation |
|---|---|
| Other local user/process spends the key | token required: `x-api-key` or `Authorization: Bearer` must equal the stored placeholder (constant-time compare); else 401 before anything else. Loopback bind only; no `0.0.0.0` option exists |
| Open proxy / SSRF (client picks host, scheme or path) | upstream = one URL from config, built as `new URL(upstreamBase + path)` and rejected unless `origin` equals the config origin; request path must match `^/v1/` and contain no `..`, `//`, `\`, `@`, or encoded variants; `Host`, absolute-form request lines and `CONNECT` are refused (405/400). The client cannot change scheme, host or port |
| Key or headers in logs | proxy logs only method, path (no query), status, latency, byte counts, nodeless request id. Never headers, bodies, query strings. Reuse `redactSecrets` on error messages; errors are static codes (as `parseUpdate` does) |
| Header smuggling | request headers are rebuilt from an allowlist (`content-type`, `accept`, `anthropic-version`, `anthropic-beta`, `user-agent`, `x-stainless-*`, `x-app`, `x-claude-code-*`, `idempotency-key`...). Dropped: `x-api-key`, `authorization`, `host`, `content-length`, `cookie`, `proxy-*`, `forwarded`, `x-forwarded-*`, all hop-by-hop (`connection`, `keep-alive`, `transfer-encoding`, `te`, `trailer`, `upgrade`). Then the real credential and configured custom headers are added |
| Resource exhaustion | request body cap 32 MB (413; images/long context), max 64 in-flight (429 `proxy_busy`), TTFB timeout 120 s (clears when headers arrive), per-chunk idle timeout 300 s for streams. No per-second rate limit: many agents share one key legitimately |
| Stuck streams / orphaned upstream calls | client abort (`req.signal`) is wired into the upstream `fetch` `AbortController`; upstream body error closes the client stream; both directions tested |
| Response manipulation | status and a response header allowlist are forwarded; drop `content-length`/`content-encoding` when Bun decoded the body (use `decompress`-safe handling: belum diverifikasi, covered by the SSE integration test comparing bytes) and `set-cookie` |
| Upstream credential in error bodies | proxy answers its own failures with an Anthropic-shaped error `{type:"error",error:{type:"api_error",message:"webterm credential proxy: <code>"}}`: 502 `upstream_unreachable`, 504 `upstream_timeout`, 503 `no_upstream`, 401 `bad_proxy_token`. Claude Code shows these; the connection test classifies them (6) |

Honest limit: the proxy removes the key from *environments*, not the ability to *use* it. Anyone who
has the placeholder (every process of an agent session, by design) can make API calls through it,
including the agent's own Bash. The in-flight cap and path allowlist bound that; they do not prevent it.

## 5. SCRUB logic

- `providerEnv(c, secret)` becomes `providerEnv(c, proxy)`: key modes return `set = { ANTHROPIC_API_KEY: proxy.token, ANTHROPIC_BASE_URL: proxy.url, [ANTHROPIC_MODEL] }`, `unset` = every provider var + cloud flags + `ANTHROPIC_CUSTOM_HEADERS` + `SCRUB_VAR` not in `set`. `proxy` null while the card needs one (proxy not started) = **throw `credential_proxy_unavailable`**: fail closed, never fall back to the real key.
- `agentEnv.ts` `providerEnvFrom(env)`: no longer copies `ANTHROPIC_API_KEY`/`AUTH_TOKEN`/`CUSTOM_HEADERS` and no longer adds `SCRUB_VAR`; it takes the proxy endpoint (parameter) and emits the same placeholder/URL. `CREDENTIAL_VARS` stays only as the "forbidden in any child env" list. `envProxyAuth` is unchanged (placeholder + proxy URL still reads as "proxy configured": the probe `auth` stage keeps passing).
- `ptyEnv` (`ptyShell.ts`): add the credential vars to `LEAKED_ENV`, so the base env of PTY, tmux server and agent chat can never carry a real one. This closes the tmux-server leak. Plain terminals get no provider env at all.
- `claudeProvider.store.ts`: new `claudeUpstream()` returns `{ baseUrl, kind, secret, headers }` from card + secret (+ server env when the card is `login`); only the proxy imports it. `loadSecret` stays used by `providerView` (`secretSet`) and `claudeUpstream`, nothing else.
- `wrapClaudeLaunch` is unchanged (it only has the placeholder to write now; the launch-file indirection stays, it is cheap and already tested).
- Policy test `credentialProxy.env.policy.bun.test.ts` locks "no real credential in any child env": run every composer (`activeProviderEnv`, `claudeEnv`, `claudeChildEnv`, `scrubAgentEnv`, `scrubExecEnv`, `agentChatEnv`, `ptyEnv`, `launchScript`, `TmuxSupervisor.env`) with a poisoned parent env (`ANTHROPIC_API_KEY=sk-ant-REAL...`, token, custom headers, card secret in a temp `WEBTERM_DATA_DIR`) and assert no output value, key or script text contains any poisoned value, and that `SCRUB_VAR` is never set to a truthy value. Exception list is one named array (`CLAUDE_CODE_OAUTH_TOKEN`, with the reason from 2).

## 6. UI, docs, tests, module split

UI / wizard (English text):
- Provider card: after the secret field, one static line "The key stays in the webterm server. Claude gets a local proxy address instead." No new switch (zero-config: the proxy is always on for key modes).
- Test connection: unchanged flow, but it now exercises the proxy because `connectionStream.ts` uses the single composer. Add to the `auth` stage detail "via local credential proxy"; extend `FAILURE_TABLE` with `credential proxy` rows: `bad_proxy_token`/`no_upstream` -> `request_failed` with hint "Restart the Claude session" / "Save a provider key in Settings"; `upstream_unreachable`/`upstream_timeout` -> existing `network`/`timeout`. Setup wizard calls the same stream (no separate path).
- `connectivity.runtime.ts` must read the real upstream URL (`claudeUpstream().baseUrl`), not the proxy address.
- `docs/docker.md`: new short section: Claude with an API key/gateway works in the default hardened container; no `bubblewrap`, `socat`, extra caps or seccomp changes needed for it. Mention the data-dir persistence (the proxy port/token live there; a lost volume = new token, sessions restart anyway).

Tests that must exist:
1. Unit `credentialProxy.headers.test.ts`: allowlist, hop-by-hop, injected `x-api-key` vs Bearer, custom headers, path validation table (traversal, `//`, absolute URL, encoded `%2e%2e`).
2. Unit `credentialProxy.upstream.test.ts`: card/env precedence, base URL path prefix, origin lock, `no_upstream`.
3. Integration `credentialProxy.server.bun.test.ts` with a fake upstream `Bun.serve`: asserts upstream received the real credential and not the placeholder; 401 without token; SSE chunk-by-chunk passthrough; client abort cancels upstream (fake upstream observes abort); upstream 5xx/timeout mapping; body cap; in-flight cap; nothing sensitive in captured log output. Must set `WEBTERM_DATA_DIR` to a temp dir (importing `db.ts` opens the real DB otherwise).
4. Lifecycle `credentialProxy.lifecycle.bun.test.ts`: first start stores port+token; restart reuses both; port taken -> new port stored and notice emitted.
5. Policy tests: env policy from 5; scanner `credentialProxy.spawn.policy.test.ts`: every non-test file under `src/server` that calls `spawn`/`execFile`/`Bun.spawn`/`spawnPty` with a Claude launch (`launch.argv`, `centralClaudeLaunch`, `claudeEnv`) must import the composer module, and none may read `process.env.ANTHROPIC_*` directly except `credentialProxy/` and the dotenv/ptyShell strip lists. Register in `scripts/test.policy.manifest.ts`.
6. Update existing: `agentEnv.test.ts`, `claudeProvider.model.test.ts`, `claudeProvider.store.test.ts`, `claudeProviderEnv.policy.bun.test.ts`, `agentChat env`, `claudeOptions.test.ts`, `agentSpawn.provider.test.ts` (they assert SCRUB=1 and a real key today).

Module split under `src/server/credentialProxy/` (each under 300 lines):
- `credentialProxy.types.ts`: `ProxyEndpoint {url, token}`, `Upstream {baseUrl, kind: 'xApiKey'|'bearer', secret, headers}`, error codes.
- `credentialProxy.headers.ts`: pure header allowlist/strip/inject, hop-by-hop, response header filter.
- `credentialProxy.upstream.ts`: resolve `Upstream` (calls `claudeProvider.store` + server env), path validation, origin lock.
- `credentialProxy.server.ts`: `createProxyHandler(deps)` (auth, limits, fetch, stream, abort) and `Bun.serve` wrapper.
- `credentialProxy.lifecycle.ts`: persisted token/port, `startCredentialProxy`/`stopCredentialProxy`, `activeEndpoint()`.
- `credentialProxy.env.ts`: the single composer used by `claudeEnv`, `agentChatEnv`, `providerEnvFrom`.

## 7. Implementation waves (file ownership, no overlap inside a wave)

- **Wave 1** (parallel):
  - W1a owns `credentialProxy/credentialProxy.{types,headers,upstream}.ts` + their unit tests (1, 2).
  - W1b owns `agentEnv.ts`, `claudeProvider/claudeProvider.{model,store,launch}.ts`, `credentialProxy/credentialProxy.env.ts`, `ptyShell.ts`, `dotenvFiles.ts`, `agentChat/agentChat.env.ts`, `central/runtime/claudeOptions.ts` + the existing tests they break (6) + policy test (5a). Uses the `ProxyEndpoint` type from this doc until W1a lands (a throwaway local interface is not allowed; W1b starts with `types.ts` written first by W1a, small, within minutes: order inside the wave is types first).
- **Wave 2** (parallel, after Wave 1 merged):
  - W2a owns `credentialProxy.server.ts`, `credentialProxy.lifecycle.ts` + tests 3, 4.
  - W2b owns `server.main.ts`/`bootWiring.ts` hook, `connectivity.runtime.ts`, `claudeProvider.connectionTest.ts`, `claudeProvider.connectionStream.ts`, client Provider card text, and the scanner test (5b) + manifest entry.
- **Wave 3** (single worker): `docs/docker.md`, README contract lines (Provider/Docker only, no narrative rewrite), CHANGELOG, this document's status line.

Done criteria (run in the office container with the default hardened compose, no bwrap):
1. Card `apiKey` or `custom`: `claude -p "reply OK"` in a PTY agent session, headless exec, agent chat and Central helper all succeed; Settings "Test connection" returns ok.
2. In that session the Bash tool runs (`echo ok`) and `env | grep -E 'ANTHROPIC|SCRUB'` shows only the placeholder, the proxy URL and model vars; the real key appears in no process env (`tr '\0' '\n' < /proc/*/environ | grep -c <real key>` = 0 for every pid, including the tmux server) and not in `ps` argv.
3. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is absent in all of the above.
4. Restart the webterm server while an agent session is idle and while one is mid-turn: both continue on the same proxy address without restarting the session (the mid-turn result is the check for the retry-watchdog question in 3).
5. Fake-upstream integration test shows the real credential only on the upstream hop; Typecheck + `test:impacted` + the policy tier green. No full suite (owner-only).
6. Interactive TUI start with the placeholder key does not stall on an "approve this API key" prompt (belum diverifikasi; if it does, the fix is the stable placeholder + the approved-keys entry, decided then, not now).

## 8. Honest limits

- The real key still lives in `<dataDir>/claude-provider/SECRET` (0600). A process running as the same user can read that file; the agent sandbox's `denyRead` on the data dir helps only when the sandbox is active. The proxy closes the leak through **environment** (`/proc/*/environ`, `ps e`, tools that dump env, the scrub requirement), not file access. Not a task.
- A session holding the placeholder can still use the key through the proxy (4).
- OAuth login and `command`-mode credentials are outside the proxy (2).
