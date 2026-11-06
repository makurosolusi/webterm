// WebSocket wire protocol between the canvas client and the terminal server.
// One socket multiplexes many terminals by `id` (client-generated, stable across
// reconnects so the server can re-attach a surviving PTY and replay its scrollback).

import type { AgentId, AgentStatus } from './workspace'

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
export type ClientMsg = OpenMsg | InputMsg | ResizeMsg | CloseMsg | DetachMsg | FsWatchMsg | FsUnwatchMsg

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
export type ServerMsg = OutputMsg | ExitMsg | ResetMsg | StatusMsg | FsDirtyMsg

export const WS_PATH = '/ws'
