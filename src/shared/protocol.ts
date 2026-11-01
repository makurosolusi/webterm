// WebSocket wire protocol between the canvas client and the terminal server.
// One socket multiplexes many terminals by `id` (client-generated, stable across
// reconnects so the server can re-attach a surviving PTY and replay its scrollback).

import type { AgentId, AgentStatus } from './workspace'

export interface OpenMsg { t: 'open'; id: string; cols: number; rows: number; cwd?: string; cmd?: string; agentId?: AgentId; sessionId?: string; resume?: boolean }
export interface InputMsg { t: 'input'; id: string; data: string }
export interface ResizeMsg { t: 'resize'; id: string; cols: number; rows: number }
export interface CloseMsg { t: 'close'; id: string }
export type ClientMsg = OpenMsg | InputMsg | ResizeMsg | CloseMsg

// `seq` = nomor urut potongan dari `OutputLog`. Additif dan opsional supaya server lama/client lama
// tetap saling bicara; kehadirannya membuat client bisa tahu ada potongan yang hilang saat re-attach.
export interface OutputMsg { t: 'output'; id: string; data: string; seq?: number }
// `reason` membedakan proses yang keluar SENDIRI (`self`) dari yang kita tutup (`closed`). Opsional
// untuk kompatibilitas wire: client yang belum membacanya cukup memakai `code`.
export interface ExitMsg { t: 'exit'; id: string; code: number; reason?: 'self' | 'closed' }
// `status` ABSEN = "tidak ada status lagi" (sapuan basi, lihat `agentStale.ts`), bukan "tidak
// berubah". Satu-satunya cara server bisa MENCABUT klaim yang pernah ia kirim.
export interface StatusMsg { t: 'status'; id: string; status?: AgentStatus }
export type ServerMsg = OutputMsg | ExitMsg | StatusMsg

export const WS_PATH = '/ws'
