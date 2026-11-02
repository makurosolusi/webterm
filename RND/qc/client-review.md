# QC review — P0 client (exit reason) + B1 (workspace save flush)

Scope: `src/client/ws.ts`, `terminalSession.ts`, `TerminalCore.tsx`, `ws.test.ts`,
`terminalSession.test.ts`, `App.tsx`, `workspaceLifecycle.ts`, `workspaceCommit.test.ts`.
Branch `feature/agent-pusat-p0` @ `b4e7f01` + uncommitted test edits in 5 files
(`git status`), incl. the third `P0:` case in `workspaceCommit.test.ts`. Read-only review:
no production code or test was modified.

Verification run: `npx vitest run src/client/{ws,terminalSession,workspaceCommit}.test.ts
src/client/terminalCore.test.tsx` → 34 passed; `npx tsc --noEmit` → clean.

**Verdict: no blockers.** Payload-locking in `useWorkspaceSaver` is correct on every path that
mutates `activeWsRef` (boot, `onSelect`, `onCreateWorkspace`, `onDeleteWorkspace`,
`onRenameWorkspace`, `fire` itself), and the flush-before-switch order in `applyWorkspace`
(`App.tsx:122-136`) is the right shape. Exit-reason plumbing is wire-compatible with an old
server (`reason === undefined` still prints).

| # | Sev | Finding | Evidence | Suggested test |
|---|-----|---------|----------|----------------|
| 1 | Med | `closed` suppression is not client-local. `reason` is the server's intent, so any peer that closes the node (second browser tab, another workspace's SessionsPanel, server-side cleanup) now prints nothing in *every* terminal on that id. "Closed elsewhere" becomes indistinguishable from "still running". Suppression should key on ids *this* client closed (record in `send({t:'close'})`), and print a neutral notice otherwise. | `ws.ts:87-92`, `terminalSession.ts:8-9`, `server/sessions.ts:235-237` | `ws.test`: subscribe, deliver `exit{reason:'closed'}` with no local `close` sent → expect neutral text (today `''`); then send `close` locally → expect `''`. |
| 2 | Med (pre-existing, in the reconnect/replay path) | No unsubscribe on exit: the `sub` and its `open` survive. On the next reconnect `onopen` calls `onReset` (wipes the final scrollback) and replays `open`; the server finds no `map` entry and **spawns a fresh PTY**, with `--resume` for agents (`replayOpen`). A WiFi blip after `[... exited]` silently relaunches the shell/agent and erases the evidence. | `ws.ts:55-57`, `ws.ts:87-92`, `ws.ts:115-121`, `server/sessions.ts:143-160` | `ws.test`: deliver `exit` for a sub, drop + reconnect the socket → assert no `open` was replayed for that id (add `subs.delete` on exit, or an `exited` flag). |
| 3 | Low | `onDeleteWorkspace` still can resurrect the row it just deleted: `cancelSave()` runs *before* `await getWorkspace(id)`; a `scheduleSave` during that await (board is still interactive) re-arms a PUT for the doomed id and `PUT`=upsert. | `workspaceLifecycle.ts:237`, `:243-245` | Commit test: click delete on active workspace, add/drag a node during the GET, assert zero PUT after the DELETE. |
| 4 | Low | `flushSave()` fires the PUT without awaiting, then `onSelect` GETs the target. A fast A→B→A can install a pre-flush A board (last edit invisible; next save can then overwrite server with it). | `workspaceLifecycle.ts:109-114`, `:162-167` | Commit test: mock fetch so GET A returns the pre-flush body; assert either the stale body is not installed or `onSelect` awaits the flush. |
| 5 | Low | Two `ExitReason` declarations plus a now-redundant widening cast. `protocol.ts:18` already has `reason`, so `const exit = msg as …` only hides a future wire rename from tsc. | `ws.ts:19`, `ws.ts:90`, `terminalSession.ts:1`, `shared/protocol.ts:18` | Typecheck-only: import `ExitMsg`/one shared type and drop the cast. |
| 6 | Low | `scheduleSave` is called from inside `setNodes` updaters. Payload capture now happens in a phase React may replay/abort, so an uncommitted `next` can be the queued payload; StrictMode invokes the updater twice (arm/cancel twice is harmless, but it shows the effect is running off-render). | `App.tsx:149-167` (`scheduleSave()` at `:159`, `:164`) | Render test: invoke the updater path twice with different `prev`, assert only the committed board is PUT. |
| 7 | Low (by design, untested) | App unmount drops the pending edit (`cancelSave` only). Fine in production, but the reload path loses the last 400 ms with no test pinning the intent either way. | `App.tsx:103-107` | Commit test: add a node, unmount inside the debounce → no PUT, no unhandled rejection. |
| 8 | Low | `subscribe` still overwrites unconditionally and its cleanup deletes by id only. Two subscribers on one id (remount race, future multi-subscriber seam) → the first cleanup kills the live one; the replaced sub also loses the remembered `open`. | `ws.ts:144-153`, `ws.ts:55-57` | `ws.test`: subscribe twice for one id, run the first unsubscribe, deliver `output` → second callback still fires. |

Test-gap notes (nothing failing today):

- `ws.test`: no case for an unknown `reason` (e.g. `'killed'`) → must still print; no case for an
  `exit` for an id with no subscriber.
- `workspaceCommit.test`: rapid double switch (A→B→C inside one debounce) writes only the first
  board; nothing asserts that B's flush is not attributed to A.
- `terminalSession.test` covers `exitMessage` but not that `TerminalCore`'s subscription forwards
  the reason (only the `ws.ts` layer is exercised for it).
