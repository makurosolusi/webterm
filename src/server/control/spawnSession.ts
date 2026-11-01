// Penentuan session id untuk spawn lewat control plane.
//
// `launchLine` (src/server/launchLine.ts) hanya merakit `--settings`/hook claude bila ada
// `sessionId`. Spawn lewat WebSocket selalu membawa session id dari client, jadi tanpa minting di
// sini node hasil control plane tidak pernah mendapat hook (B4). Nilai dari client DIPERIKSA, tidak
// dipercaya: session id mendarat di baris perintah shell.

import { randomUUID } from 'node:crypto'
import { isSafeSessionId, mintsSessionId, type AgentId } from '../../shared/workspace'

export type SpawnSessionId = { ok: true; sessionId?: string } | { ok: false }

/**
 * `undefined` = tidak ada session id yang dikirim client.
 * - Agent yang memang menerima flag session-id (`mintsSessionId`) mendapat UUID baru.
 * - Agent lain tidak mendapat field `sessionId` sama sekali.
 * - Session id dari client harus lolos `isSafeSessionId(bounded)`; yang tidak lolos ditolak.
 */
export function resolveSpawnSessionId(agentId: AgentId, supplied: unknown): SpawnSessionId {
  if (supplied !== undefined) {
    if (typeof supplied !== 'string' || !isSafeSessionId(supplied, true)) return { ok: false }
    return { ok: true, sessionId: supplied.trim() }
  }
  return mintsSessionId(agentId) ? { ok: true, sessionId: randomUUID() } : { ok: true }
}
