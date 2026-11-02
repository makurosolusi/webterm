// Gerbang identitas hook `POST /api/agent-status`: siapa pemanggilnya, dan apakah token transport
// yang dibawanya milik node yang dituju. Dipisah dari `agentStatusApi` supaya file route tetap di
// bawah budget route-nya; modul ini tidak menyentuh registry maupun body request.
import type { IncomingMessage } from 'node:http'
import { nodeIdForToken, NODE_TOKEN_HEADER } from './hooks'
import { TOKEN_HEADER } from './auth'
import { firstHeader } from './httpHeaders'

/**
 * Gerbang identitas hook, dibaca SEKALI saat modul dimuat. Default MATI: perilaku lama fail-open
 * (hook tanpa token tetap memperbarui status) dipertahankan persis. `WEBTERM_STRICT_HOOK_AUTH=1`
 * membalik endpoint menjadi tertutup: token node wajib, dan `transcript_path` wajib berada di
 * bawah root transcript claude / data dir webterm.
 */
export const STRICT_HOOK_AUTH = process.env.WEBTERM_STRICT_HOOK_AUTH === '1'

/** Header token node, apa adanya dari request (Node menurunkan nama header ke lowercase). */
export const nodeTokenHeader = (req: IncomingMessage): string | string[] | undefined =>
  req.headers['x-nodeterm-node-token']

/**
 * Node yang DIBUKTIKAN oleh token transport request ini, atau `undefined` bila tokennya bukan token
 * node (root token, tanpa token, atau token asing).
 *
 * `x-webterm-token` dulu: itu header transport yang membawa token node di baris hook, dan jalur
 * `authorizeRequest` sudah menerimanya. `x-nodeterm-node-token` tetap dibaca sebagai cadangan —
 * sesi agent lama hanya mengirim header protokol itu.
 */
export function requesterNodeId(req: IncomingMessage): string | undefined {
  const raw = req.headers[TOKEN_HEADER] ?? req.headers[NODE_TOKEN_HEADER]
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
