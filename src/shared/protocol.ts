// WebSocket wire protocol between the canvas client and the terminal server.
// One socket multiplexes many terminals by `id` (client-generated, stable across
// reconnects so the server can re-attach a surviving PTY and replay its scrollback).

import type { AgentId, AgentStatus, BridgeLink, WsNode } from './workspace'
import type { TabGroup } from './tabLayout.schema'

// `since` = the last chunk this client already drew of session `epoch`: a re-attach to that same
// session replays only what came after it. Absent, stale or out of range = `reset` + full replay.
export interface ReplayFrom { epoch: string; seq: number }
export interface OpenMsg { t: 'open'; id: string; cols: number; rows: number; cwd?: string; cmd?: string; agentId?: AgentId; sessionId?: string; resume?: boolean; claudeProfileId?: string; since?: ReplayFrom }
export interface InputMsg { t: 'input'; id: string; data: string }
export interface ResizeMsg { t: 'resize'; id: string; cols: number; rows: number }
export interface CloseMsg { t: 'close'; id: string }
// The terminal view unmounted: stop streaming to this socket, keep the session running.
export interface DetachMsg { t: 'detach'; id: string }
// Langganan perubahan direktori untuk node files (flag WEBTERM_FILES_WATCH). `dir` absolut/`~`.
export interface FsWatchMsg { t: 'fswatch'; dir: string }
export interface FsUnwatchMsg { t: 'fsunwatch'; dir: string }
// App-level heartbeat: the server answers `pong` with the same `id`. Browsers cannot see ws-level
// pings, so this is how a tab detects a half-open socket (no pong in time = reconnect).
export interface PingMsg { t: 'ping'; id: string }
// Server-sent event streams carried on this socket instead of an EventSource each (HTTP/1.1 allows
// 6 connections per host across all tabs; a WebSocket does not count). `url` = a GET /api/ SSE route.
export interface StreamSubMsg { t: 'sse.sub'; id: string; url: string }
export interface StreamUnsubMsg { t: 'sse.unsub'; id: string }
export type ClientMsg = OpenMsg | InputMsg | ResizeMsg | CloseMsg | DetachMsg | FsWatchMsg | FsUnwatchMsg | PingMsg | StreamSubMsg | StreamUnsubMsg

// `seq` = nomor urut potongan dari `OutputLog`. Additif dan opsional supaya server lama/client lama
// tetap saling bicara; kehadirannya membuat client bisa tahu ada potongan yang hilang saat re-attach.
export interface OutputMsg { t: 'output'; id: string; data: string; seq?: number }
// `reason` membedakan proses yang keluar SENDIRI (`self`) dari yang kita tutup (`closed`). Opsional
// untuk kompatibilitas wire: client yang belum membacanya cukup memakai `code`.
// `kind_mismatch` = the open was refused: the live session under this id is a different kind
// (agent vs plain terminal), so attaching would show someone else's process.
// `failed` = the server could not start the session at all (agent-211-A1); its notice came first.
export interface ExitMsg { t: 'exit'; id: string; code: number; reason?: 'self' | 'closed' | 'kind_mismatch' | 'failed' }
// Sent before a FULL replay: the client clears its screen and restarts its seq at 0 for `epoch`.
export interface ResetMsg { t: 'reset'; id: string; epoch: string }
// `status` ABSEN = "tidak ada status lagi" (sapuan basi, lihat `agentStale.ts`), bukan "tidak
// berubah". Satu-satunya cara server bisa MENCABUT klaim yang pernah ia kirim.
export interface StatusMsg { t: 'status'; id: string; status?: AgentStatus }
// Petunjuk "isi `dir` berubah" (bukan diff): klien menjawab dengan me-refresh listing.
export interface FsDirtyMsg { t: 'fsdirty'; dir: string }
// The server added `nodes`/`bridges` to board `workspaceId`, on top of stored version `base`, storing
// version `updatedAt`: the UI merges ids it lacks (`base` tells a window whether it knew what lay underneath).
// `removed` = node ids the server took off the board (their sessions already ended) along with every
// cable touching them; such a frame carries empty `nodes`/`bridges`.
// `updated` = existing nodes the server patched (full node; the UI takes its x/y/size/title/color/collapsed/hideLinks,
// and an agent chat node's chatSessionId/chatConfig/permissionMode, which its server session stores as they change,
// and kind/agentId/sessionId/cmd when a Claude node switches between its chat and terminal views).
// `unlinked` = cable ids the server removed.
/** The fields of an `updated` node a window takes from the push (server `canvasPush.update`). */
export const CANVAS_PATCH_KEYS = ['x', 'y', 'width', 'height', 'title', 'color', 'collapsed', 'hideLinks', 'chatSessionId', 'chatConfig', 'permissionMode', 'kind', 'agentId', 'sessionId', 'cmd'] as const
// `groups` = the board's whole Layers group list after a server edit (`canvasPush.groups`); the UI
// takes it as is and re-packs members into its own tab `order`.
// `name` = the board's new name (Central's `workspace.rename`); versioned like every push, so an unsent
// save neither reverts it nor 409s on it.
export interface CanvasMsg { t: 'canvas'; workspaceId: string; base: number; updatedAt: number; nodes: WsNode[]; bridges: BridgeLink[]; removed?: string[]; updated?: WsNode[]; unlinked?: string[]; groups?: TabGroup[]; name?: string }
// Central asked the UI to show workspace `workspaceId` (and centre/reveal `nodeId` when given, or
// with `fit` fit every node into view, the "View: Fit Canvas" command).
export interface ViewMsg { t: 'view'; workspaceId: string; nodeId?: string; fit?: boolean }
// Central asked for a screenshot: the visible UI tab captures its view and POSTs it to /api/canvas-shot/<reqId>.
export interface ShotMsg { t: 'shot'; reqId: string; maxWidth: number }
// The workspace list changed on the server (Central's `workspace.create`): each window adds the boards it lacks.
export interface WorkspacesMsg { t: 'workspaces' }
export interface PongMsg { t: 'pong'; id: string }
// First frame on every connection: `bootId` changes per server process start, `build` per release/rebuild.
export interface HelloMsg { t: 'hello'; bootId: string; build: string }
// Stream `id` answered 200 text/event-stream (EventSource `open`).
export interface StreamOpenMsg { t: 'sse.open'; id: string }
// One dispatched SSE event; `lastId` = the stream's last `id:` so far (EventSource `lastEventId`).
export interface StreamEventMsg { t: 'sse.ev'; id: string; event: string; data: string; lastId: string }
// The stream ended (`status` 200) or was refused (its HTTP status). Nothing follows for this id.
export interface StreamEndMsg { t: 'sse.end'; id: string; status: number }
export type ServerMsg = OutputMsg | ExitMsg | ResetMsg | StatusMsg | FsDirtyMsg | CanvasMsg | ViewMsg | ShotMsg | WorkspacesMsg | PongMsg | HelloMsg | StreamOpenMsg | StreamEventMsg | StreamEndMsg

export const WS_PATH = '/ws'
/** `{bootId, build}` behind the /api gate: lets a failing socket tell "server down" from "credential refused". */
export const HEALTH_PATH = '/api/health'
