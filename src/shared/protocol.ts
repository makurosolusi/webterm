// WebSocket wire protocol between the canvas client and the terminal server.
// One socket multiplexes many terminals by `id` (client-generated, stable across
// reconnects so the server can re-attach a surviving PTY and replay its scrollback).

import type { AgentId, AgentStatus } from './workspace'

export interface OpenMsg { t: 'open'; id: string; cols: number; rows: number; cwd?: string; cmd?: string; agentId?: AgentId; sessionId?: string; resume?: boolean }
export interface InputMsg { t: 'input'; id: string; data: string }
export interface ResizeMsg { t: 'resize'; id: string; cols: number; rows: number }
export interface CloseMsg { t: 'close'; id: string }
export type ClientMsg = OpenMsg | InputMsg | ResizeMsg | CloseMsg

export interface OutputMsg { t: 'output'; id: string; data: string }
export interface ExitMsg { t: 'exit'; id: string; code: number }
// `status` ABSEN = "tidak ada status lagi" (sapuan basi, lihat `agentStale.ts`), bukan "tidak
// berubah". Satu-satunya cara server bisa MENCABUT klaim yang pernah ia kirim.
export interface StatusMsg { t: 'status'; id: string; status?: AgentStatus }
export type ServerMsg = OutputMsg | ExitMsg | StatusMsg

export const WS_PATH = '/ws'
