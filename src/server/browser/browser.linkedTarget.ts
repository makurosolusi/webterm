// Target browser untuk agent PTY, diselesaikan SAAT PANGGILAN dari kabel (edge) node agent itu sendiri — pola
// context-link (`contextLinkRoute.ts`): identitas = token node, izin = edge di board yang tersimpan. Menyambung kabel
// setelah agent jalan langsung berlaku; melepasnya langsung mencabut. Meniru Orca (`browser-command-targets.ts`:
// halaman dipilih per panggilan dari worktree pemanggil, error jelas bila tak ada) dan nodeterm (`browser-drive.ts`:
// gerbang dibaca LIVE saat drive, identitas pemanggil terverifikasi).
import { BROWSER_KIND } from '../../shared/browser.contract'
import type { Workspace } from '../../shared/workspace'
import { TOKEN_HEADER } from '../auth'
import { findWorkspaceFor, linkedPeerIds } from '../contextLinkRoute'
import { NODE_TOKEN_HEADER, nodeIdForToken } from '../hooksTokens'
import { firstHeader } from '../httpHeaders'
import type { ControlHeaders, ControlResult } from '../control/controlTypes'

export interface BrowserRef { id: string; title: string }
export type LinkedTarget = { ok: true; nodeId: string } | { ok: false; result: NonNullable<ControlResult> }

/** Node agent yang DIBUKTIKAN token node request ini (header transport dulu, header protokol nodeterm cadangan). */
export function requesterOf(headers: ControlHeaders | undefined): string | undefined {
  const token = firstHeader(headers?.[TOKEN_HEADER] ?? headers?.[NODE_TOKEN_HEADER])
  return token ? nodeIdForToken(token) : undefined
}

const WIRE_HINT = 'Ask the user to connect this terminal node to a browser node with a cable (edge) on the webterm canvas; it works immediately, no restart.'

/**
 * Browser yang boleh dikemudikan `requesterId`: hanya node browser yang terhubung kabel dengannya. `wanted` (opsional)
 * memilih salah satu; tanpa `wanted` satu kabel = otomatis, beberapa = wajib pilih, nol = error yang menyuruh minta kabel.
 */
export function resolveLinkedBrowser(workspaces: Workspace[], requesterId: string, wanted?: string): LinkedTarget {
  const ws = findWorkspaceFor(workspaces, requesterId)
  if (!ws) return deny(404, 'not_on_board', 'This session is not a node on any webterm board.')
  const ref = (n: Workspace['nodes'][number]): BrowserRef => ({ id: n.id, title: n.title || n.id })
  const browsers = ws.nodes.filter((n) => n.kind === BROWSER_KIND)
  const peers = linkedPeerIds(ws, requesterId)
  const linked = browsers.filter((n) => peers.has(n.id)).map(ref)
  const available = browsers.map(ref)
  if (wanted !== undefined) {
    if (linked.some((b) => b.id === wanted)) return { ok: true, nodeId: wanted }
    return deny(403, 'not_linked', `Browser node "${wanted}" is not wired to this agent node. ${WIRE_HINT}`, { linked, available })
  }
  if (linked.length === 1) return { ok: true, nodeId: linked[0].id }
  if (linked.length > 1) return deny(409, 'ambiguous_browser', 'Several browser nodes are wired to this agent node; pass --node <id>.', { linked })
  return deny(404, 'no_linked_browser', `No browser node is wired to this agent node. ${WIRE_HINT}`, { available })
}

const deny = (status: number, error: string, message: string, extra: object = {}): LinkedTarget =>
  ({ ok: false, result: { status, body: { error, message, ...extra } } })
