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

## Accounts (2026-11-11)

Code: `src/server/uiUser.ts`, `src/server/setupCode.ts`, `src/server/loginThrottle.ts`,
`src/server/routes/auth.routes.ts`, `src/server/routes/auth.account.routes.ts`, `src/server/bootWiring.ts`.

Humans now sign in with a username and password; the root token stays for machines.

1. **First account.** `POST /auth/setup` creates the only account and needs proof that the caller is
   on this machine: a live `wt_ui` session (token era, or a window the server opened) OR the setup code
   in `<data dir>/secrets/SETUP_CODE` (0600). Boot prints one line naming that file, never the value. A
   local process that can only reach the port cannot claim a fresh install. Setup calls are serialised,
   so two at once give one 201 and one 409. Success clears the code and revokes every earlier session.
2. **Fresh session on every sign-in.** Login, setup and token sign-in revoke the cookie the caller sent
   and set a new one (no session fixation). Sessions store the User-Agent (200 chars) for the list.
3. **Throttle.** Failed logins and failed password checks back off per account and per socket peer
   (`req.socket.remoteAddress`; `X-Forwarded-For` is ignored because the client sets it). 429 carries
   `Retry-After`. There is no permanent lockout. `auth.login_failed` logs no username.
4. **Token sign-in for humans ends at the first account.** `POST /auth/login { token }` answers 409
   `token_sign_in_disabled` once an account exists. The token still works in `x-webterm-token`, and
   `/api` and the WebSockets keep accepting cookie, token or node token as before. Rotate stays.
5. **`/auth/open` stays passwordless.** A window the server opens on this machine (a one-time code
   in a 0600 file) still signs in without a password, bound to the account when exactly one exists.
   Whoever can read the data dir can already read the token, so a password adds nothing there.
   `next=` is followed only for a same-origin path (`/x`; not `//x`, `/\x`, a scheme or a control character).
6. **Own sessions only.** `/auth/sessions` lists and revokes the caller's sessions (token-era sessions
   when no account exists). A password change revokes every other session of the user.

References: code-server (password login -> session cookie), OWASP ASVS 3.2/3.3 (new session on login,
logout elsewhere on password change), NIST 800-63B (length rules, throttling without lockout).

Locks: `src/server/routes/auth.account.routes.bun.test.ts`, `src/server/routes/auth.routes.bun.test.ts`.

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
- The Host allowlist against DNS rebinding (`WEBTERM_ALLOWED_HOSTS`) was active only while no token was
  enforced. Every boot now enforces one, so it could never switch on; it was removed (2026-11-06). DNS
  rebinding stays closed by the credential: a rebinding page has no root token header and no `wt_ui`
  cookie for this origin, so it gets 403.
- There is no `webterm open` operator command. A headless setup creates the account with the setup code
  from the file the boot line names (before accounts: pasted the token); neither value is ever printed.

Locks: `src/server/boot.zeroenv.bun.test.ts` (every `/api` path and `/ws` refuses no credential and
`?token=`, and the token is never logged), `src/server/routes/route.uiOnly.policy.bun.test.ts` (forged
fetch metadata without the cookie opens no human-only route), `src/server/auth.test.ts`,
`src/server/wsOrigin.test.ts`.
