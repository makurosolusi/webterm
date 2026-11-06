# The webterm UI signs in with an HttpOnly session cookie

Supersedes [approval-ui-origin.md](approval-ui-origin.md). Code: `src/server/auth.ts` (`authorizeRequest`),
`src/server/uiSession.ts`, `src/server/uiOpen.ts`, `src/server/routes/auth.routes.ts`,
`src/server/approvalAuth.ts` (`uiOnlyDenial`), `src/server/wsOrigin.ts`, `src/client/appBoot.tsx`.

## Context

Until now a loopback bind had no credential at all, and the UI carried a token in `?token=` on HTTP,
WebSocket and EventSource URLs elsewhere. The human-only routes (approvals, token enable/rotate, files,
workspaces) told the webterm page apart from a script by `Sec-Fetch-Site: same-origin` plus a matching
`Origin`. Those headers are forbidden to page JavaScript, but any local process can send them. A
sandboxed agent cannot read the data dir, yet it can curl 127.0.0.1, so one forged header approved its
own actions or enabled a token it then knew (sec-208-1). Tokens in URLs also end up in history, logs and
`Referer`.

## Decision

1. **Always credentialed.** Every boot has a root token: the env value, else the file
   `<data dir>/secrets/WEBTERM_TOKEN` (mode 600), else a newly minted one written there. Loopback is no
   exception. A request to `/api/*`, `/ws`, `/ws/browser` or `/ws/lsp` needs one of:
   - the root token in the `x-webterm-token` header (operator scripts),
   - a live `wt_ui` cookie on a same-origin request (the webterm page),
   - a node token on the node-token paths (`isNodeTokenPath`: hooks, context-link, `/api/tools`,
     `/api/control/*`), or a capability on `/api/control/*`.

   Only `/auth/*`, the Telegram webhook (its own secret) and static assets are open.
2. **No credential in a URL.** The server never reads a token from the query string. The only place a
   token still appears in a URL is the `/?token=` landing link, which the client trades once for the
   cookie through `POST /auth/login` and removes from the address bar first.
3. **The cookie.** `wt_ui` is HttpOnly and SameSite=Strict, and the server keeps only its sha256
   (`ui_session` table in `webterm.db`). It expires after 30 days without a request. It counts only after
   the same-origin check, because cookies ignore ports and the dev-server proxy port would otherwise
   carry it. The proxy strips it before a dev server sees the request.
4. **Zero-config sign-in.** At boot with no live session and an interactive terminal, the server opens
   the default browser on a 0600 redirect file in `<data dir>/run/` that holds a one-time code (60 s,
   single use). The browser lands signed in. A signed-out tab can ask for another window
   (`POST /auth/request-open`, at most one per 10 s), or paste the token. A restart with a live session
   opens nothing.
5. **Human-only routes need the cookie.** `uiOnlyDenial` refuses an agent credential, then requires
   same-origin fetch metadata AND a live `wt_ui` cookie. The `uiOnly` route wrapper also admits the root
   token header. Forged fetch metadata without the cookie gets exactly what a plain curl gets.
6. **Signed out, the app does not start.** `appBoot.tsx` asks `GET /auth/me` before rendering. A
   signed-out browser renders only the sign-in screen, so no settings, history or presence request is
   refused.
7. **Agent sandbox label.** A sandboxed Claude session on macOS is labelled *protected*: the API is
   reachable, but every credential (the token file, the browser profile that holds the cookie, other
   nodes' token files) is outside what the sandbox may read, and `webterm.db` holds only cookie hashes.

## References

- Jupyter Server: a token printed to the terminal and a 0600 redirect file opened in the browser
  (`use_redirect_file`), then a cookie.
- VS Code server (`--connection-token`, cookie `vscode-tkn`) and code-server (HttpOnly session cookie
  after login): a secret delivered out of band is traded once for a cookie, and URLs stay clean.
- nodeterm revocable sessions: only a hash of the session is stored.

## Accepted risks and known limits

- An unsandboxed process running as the same user can read the token file or the browser's cookie store.
  That is out of scope, as before.
- macOS `open` runs outside the Claude sandbox. The short-lived, single-use code limits what webterm adds
  to that general escape.
- `WEBTERM_ALLOWED_HOSTS` (the Host allowlist against DNS rebinding) was active only while no token was
  enforced. Every boot now enforces one, so the allowlist is never active. A rebinding page has no
  credential for this origin and gets 403. The allowlist is kept for now and needs a separate decision:
  remove it, or make it always active on loopback binds.
- There is no `webterm open` operator command. Headless setups paste the token from the file the boot
  line names; its value is never printed.

Locks: `src/server/boot.zeroenv.bun.test.ts` (every `/api` path and `/ws` refuses no credential and
`?token=`, and the token is never logged), `src/server/routes/route.uiOnly.policy.bun.test.ts` (forged
fetch metadata without the cookie opens no human-only route), `src/server/auth.test.ts`,
`src/server/wsOrigin.test.ts`.
