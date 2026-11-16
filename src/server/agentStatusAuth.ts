// Gerbang identitas hook `POST /api/agent-status`: siapa pemanggilnya, dan apakah token transport
// yang dibawanya milik node yang dituju. Dipisah dari `agentStatusApi` supaya file route tetap di
// bawah budget route-nya; modul ini tidak menyentuh registry maupun body request.
import type { IncomingMessage } from 'node:http'
import { nodeIdForToken, nodeTokenFrom } from './hooks'
import { TOKEN_HEADER } from './auth'
import { firstHeader } from './httpHeaders'

/**
 * Hook identity gate, read ONCE at module load. ON by default (data-209-1): the node token is
 * required, and a `transcript_path` outside the claude transcript root / webterm data dir is not
 * stored. Safe as a default because the only hook caller, the managed curl line
 * (`claudeHooksSettings`, hooksSettings.ts), always sends the node's header file written by
 * `writeNodeHeaders` before every launch and re-adopt. Exactly `0` is the only off value, so a typo
 * stays closed; nothing requires setting it.
 */
export const STRICT_HOOK_AUTH = process.env.WEBTERM_STRICT_HOOK_AUTH !== '0'

/** Header token node, apa adanya dari request (Node menurunkan nama header ke lowercase). */
export const nodeTokenHeader = (req: IncomingMessage): string | string[] | undefined =>
  nodeTokenFrom((name) => req.headers[name])

/**
 * Node yang DIBUKTIKAN oleh token transport request ini, atau `undefined` bila tokennya bukan token
 * node (root token, tanpa token, atau token asing).
 *
 * `x-webterm-token` dulu: itu header transport yang membawa token node di baris hook, dan jalur
 * `authorizeRequest` sudah menerimanya. nama header node lama (legacy) tetap dibaca sebagai cadangan —
 * sesi agent dari versi sebelum rename hanya mengirim header itu.
 */
export function requesterNodeId(req: IncomingMessage): string | undefined {
  const raw = req.headers[TOKEN_HEADER] ?? nodeTokenFrom((name) => req.headers[name])
  const token = firstHeader(raw)
  return typeof token === 'string' ? nodeIdForToken(token) : undefined
}

/**
 * Apakah token transport ini milik node LAIN dari node yang dituju?
 *
 * `requester === undefined` (root/no/unknown token) selalu `false`: perilaku lama untuk pemanggil
 * tanpa identitas node tidak berubah. Hanya token node yang sah yang TERIKAT pada node-nya.
 */
export function nodeTokenMismatch(requester: string | undefined, node: string): boolean {
  return requester !== undefined && requester !== node
}
