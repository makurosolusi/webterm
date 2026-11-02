# QC review — session observation seam (b4e7f01)

Scope: `src/server/{sessions,launchLine,outputLog,subscribers,nodeRegistry,fakePty.testutil}.ts`,
`src/shared/protocol.ts`, session tests. Read-only review; no production/test files touched.
Probes run in `/Users/bip/.jcode/scratch/sessionProbe.test.ts` (bun test, outside the repo).

Tests run: `npx vitest run` on sessionsFake/subscribers/outputLog/nodeRegistry (46 pass),
`bun test` on sessions.bun / sessionsClose.bun / sessionsStale.bun / nodeRegistry (47 pass).
No existing test fails; the blocker below is **not** covered.

## B1 — BLOCKER: re-opening a live session on the same socket replays nothing

`sessions.ts:143-146` — `if (!existing.subs.add(send)) { send({status}); return }`.

`send` is one closure per **WebSocket** (`index.ts:104`), not per terminal instance. A client
that unmounts and remounts `TerminalCore` (terminals are disposed on unmount,
`TerminalCore.tsx:288-300`) re-sends `open` for the same node id over the *same* socket, so
`subs.add(send)` returns false and the new xterm stays empty while the PTY is alive.

Reachable today: switching workspace A→B→A (`App.tsx:122-136` `applyWorkspace` replaces `nodes`,
unmounting every node; PTYs are only `detach`ed on socket close, `index.ts:107`), and
`AgentNode.tsx:75,125,148` key bumps. Before this commit `open` always replayed the buffer
(git show b4e7f01 — removed `existing.send = send; for (const chunk of existing.buffer)`).

Probe evidence: open → `emitData('history')` → open with the same fn yields
`[{"t":"status","id":"n1"}]` only.

Suggested regression test: in `sessionsFake.test.ts`, replace "an existing subscriber re-opening
gets no replay duplicate" with: open, `emitData('history')`, `open` again with the same `send`,
expect `text() === 'history'` (exactly once). If dedupe is wanted, the client must send a seq
watermark in `OpenMsg` — a per-socket boolean cannot express it.

## M1 — HIGH: `seq` gap is invisible to the client

`outputLog.ts:44,59-79`; `sessions.ts:147-149`; `protocol.ts:13-15` claims `seq` lets clients
detect dropped chunks. Nothing uses `floorSeq()`/`lastSeq()` outside `outputLog.ts` (grep), the
server never sends the floor, and `client/ws.ts` discards `msg.seq` entirely.

Probe: cap 6, emit `aaaa`,`bbbb`,`cccc`, late `open` → a single `seq: 3` chunk with no marker;
a fresh terminal silently misses `aaaa`,`bbbb`. Replay after eviction is therefore a silent gap.

Suggested regression test: `OutputLog.since(0)` after eviction returns a first chunk whose
`seq > 1`, and `open` emits a `status`/`output` snapshot carrying `floorSeq` so a client can tell
"history truncated" from "no output yet".

## M2 — MEDIUM: status written after death resurrects a dead node

`sessions.ts:76-79` + `sessions.ts:270-279` (`onExit` keeps `status` as `done`).
A hook that posts late (claude writes the hook, then exits) stores `working` in the registry with
a fresh `updatedAt`; the session is gone, so nothing is broadcast and only the 20-minute sweep
clears it. Meanwhile `list()` / `/api` report `working` for a dead PTY, and
`AgentNode.tsx:159` (`status === 'done'`) blocks Resume.

Probe: after `emitExit(0)` then `setStatus('n1','working')`, `statusOf('n1') === 'working'`.

Suggested regression test: `emitExit` then `setStatus(id,'working')` → `statusOf(id)` stays
`'done'` (or the registry entry is dropped), with no message replayed to a later `open`.

## L1 — LOW: empty chunk reuses the previous `seq`

`outputLog.ts:44` returns `lastSeq()` for `''`; `sessions.ts:265-266` still broadcasts it.
Probe: `x`, `''`, `y` → seqs `[1,1,2]`, breaking the documented "monoton naik mulai dari 1"
invariant (`outputLog.ts:17-18`). Harmless for the current client (empty `data`), wrong for any
seq-based dedupe. Suggested test: `emitData('')` must not produce an output message whose `seq`
repeats the previous one.

## L2 — LOW: dead API / unexercised seam

`Sessions.subscribe` (`sessions.ts:118-123`) has no production caller (only `open`/`detach` are
wired, `sessions.ts:281-288`); it also skips replay and returns `undefined` for a dead id, i.e. a
third, half-implemented variant of `open`. `NodeRegistry.forget` (`nodeRegistry.ts:105-109`) is
likewise unused. Suggested: delete both or route them through `open` and test them.

## L3 — LOW: tombstones capped, statuses/transcripts not

`nodeRegistry.ts:89-93` bounds exits at 256, but `statuses`/`transcripts` (`nodeRegistry.ts:34-35`)
grow for every id ever spawned and are only dropped by `close`/`open`. Long-lived process, ids
that self-exit, never `close`d → slow growth. Suggested test: spawn+exit N ids, assert a cap or
that `onExit` drops the transcript.

## Checked and clean

- `close` after `onExit` never emits a second `exit`; `self` tombstone wins (`nodeRegistry.ts:80-88`;
  gated in `sessions.ts:271,234`). Probe + tests confirm one exit.
- Caller-not-subscriber gets exactly one status (+exit) — no double delivery (`sessions.ts:242-246`).
- `detach` keeps the PTY alive, removes only that send (`sessions.ts:259-261`).
- `SubscriberSet.send` iterates a snapshot and contains throwing subscribers (`subscribers.ts:47-56`).
- `OutputLog.evict` is O(n) per append batch and always keeps the newest chunk (`outputLog.ts:94-103`).
- Restart clears tombstone + status; new life restarts `seq` at 1 (`sessions.ts:207-208`) — safe
  only because the client ignores `seq` (see M1).

## Test blind spots

Note: the working tree currently carries ~205 lines of uncommitted test additions from a parallel
worker (sessionsFake/outputLog/nodeRegistry/subscribers/ws/workspaceCommit) that pass (54/54) and
**assert the B1 behaviour as intended** ("opening the same subscriber again after many chunks never
duplicates scrollback"). B1 must be resolved by replay-on-open plus a client seq watermark; simply
keeping those tests locks in the blank-remount bug.

`open` re-attach after eviction; same-`send` remount replay (encoded as correct by
`"an existing subscriber re-opening gets no replay duplicate"`); late status after exit; empty
chunk seq; `subscribe()` semantics (no replay, no status snapshot).
