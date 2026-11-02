# QC bug hunt — P0 session observation seam (`b4e7f01`)

Read-only review. Probes live outside the repo (`/tmp/qc/probe.ts`, `probe2.ts`, `probe3.ts`, run
with `bun`); no source or test in the repo was modified by this review.

Focus requested: close/reopen same id, self-exit then close, throwing subscriber, status snapshot
after sweep, `getExit` after respawn, `list` during exit, detach after close, seq after eviction,
fake-PTY timers, save flush race, invalid id.

---

## C1 — CRITICAL: pane session ids are rejected at the WebSocket boundary, so split panes get no PTY

`src/server/sessions.ts:139` — `if (!isSafeNodeId(msg.id)) return`.
`src/shared/workspace.ts:273` — `SAFE_NODE_ID = /^[A-Za-z0-9_-]{1,64}$/` (no `:`).
`src/client/paneTree.ts:82-86` — new pane ids are `` `${nodeId}:p${n}` ``.
`src/client/PaneView.tsx:98` — `TerminalCore id={p.id}`; the pane id is the session id.

**Repro** (`/tmp/qc/probe.ts` case 1):

```ts
s.open({ t: 'open', id: '3f2a9c1e-0b7d-4c2a-9f10-11aabbccdd11:p2', cols: 80, rows: 24 }, send)
// -> spawns 0, messages []
```

Also `isSafeNodeId('term-1:p2') === false` (`/tmp/qc/safe.ts`).

**Expected:** a PTY for the pane id (before this commit `open` had no id validation, and
`sessions.bun.test.ts` shows ids like `t1` are map keys, nothing more).
**Actual:** `open` returns silently: no PTY, no `status`, no error frame. `input`/`resize`/`close`
then no-op against a non-existent session, so every "Split right/down" pane — and every persisted
board that already has `data.panes` — renders a permanently blank terminal.

**Not covered:** every session test uses `t1`/`n1`-style ids; no test opens a real pane id.

**Fix direction:** widen the id grammar to the ids the client actually mints (allow `:`), or switch
`nextPaneId` to an allowed separator plus a migration for persisted boards; keep the hook-URL
defence (encoding/quoting) as-is. Regression test: `open` a `nodeId:p2` id and assert one spawn.

## H1 — HIGH: remounting a terminal inside one WebSocket replays no scrollback

`sessions.ts:143` (`if (!existing.subs.add(send)) { send({status}); return }`),
`index.ts:99/107` (`send` is one closure per socket; `detach` only on socket close),
`TerminalCore.tsx:294-299` (`unsub()` is client-side only, `term.dispose()` drops the buffer).

**Repro** (`/tmp/qc/probe3.ts`): `open(n1, send)` → `emitData('hello')` → `open(n1, send)` again
yields `[{"t":"status","id":"n1"}]` only; a *new* `send` (reconnect) gets the output replay.

**Reachable:** workspace A→B→A: `applyWorkspace` (`App.tsx:122-136`) replaces `nodes`, every node
unmounts, the PTY survives. Coming back, the fresh xterm stays empty until new output arrives.

**Expected (pre-commit):** `existing.send = send` plus a full buffer replay on every `open`.
**Actual:** replay is keyed on subscriber identity, which a remount cannot change.

Independently confirmed; same finding as `session-review.md` B1.

---

## Checked and NOT a product bug

- `close`/`detach`/self-exit ordering, one `exit{closed}` per close, `self` beating `closed`,
  `getExit` cleared on respawn, sweep→re-attach snapshot (`status` without value): all behave as
  documented in probes 1–8.
- Throwing subscriber: `SubscriberSet.send` isolates it; only `open`'s replay loop is unguarded
  (unreachable in production, `index.ts:99` never throws).
- `FakePty` has no timers; the module-level `startStaleSweep()` timer is `unref`ed.
- The two failing `P0:` probes seen when running `npx vitest run src/server` were probe bugs, not
  code bugs: the detach-mid-delivery guard fires on the `open` status message (detaching before
  `b` subscribes), and `floorSeq()===held+1` is not a gap. Full suite is green apart from
  concurrent edits by other QC workers.
- `seq` after eviction: replay starts at `floorSeq` with no marker and `client/ws.ts` ignores
  `msg.seq`, so gaps are undetectable — already reported as M1 in `session-review.md`.
