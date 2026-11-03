// Perencana pembukaan node browser (murni: tanpa DOM/RF/acak; id datang dari luar).
import type { XYPosition } from '@xyflow/react'
import { parseBrowserUrl, type UrlRejectReason } from '../shared/browser.url'
import { ANCHOR_FALLBACK_SIZE, BROWSER_OPEN_SIZE, placeBeside, type Rect, type Size } from './browser.open.place'

export type OpenBrowserReq = {
  url: string // mentah dari pemicu; divalidasi parseBrowserUrl
  anchorNodeId?: string // node sumber; penempatan di sebelahnya
  at?: XYPosition // sudut kiri-atas eksplisit (drop); mengalahkan anchor
}
export type OpenResult =
  | { status: 'created' | 'reused'; nodeId: string }
  | { status: 'invalid'; reason: UrlRejectReason }

export type PlanNode = {
  id: string
  type?: string
  position: XYPosition
  width?: number
  height?: number
  measured?: { width?: number; height?: number }
  data?: { url?: string }
}
export type OpenPlan =
  | { kind: 'reuse'; nodeId: string }
  | { kind: 'create'; nodeId: string; url: string; position: XYPosition; size: Size }
  | { kind: 'invalid'; reason: UrlRejectReason }

// Hanya untuk kunci dedupe: URL yang dikirim ke server TIDAK diubah, agar entri ALLOW_HOSTS `127.0.0.1:PORT` tetap cocok.
export const LOOPBACK_ALIASES = ['localhost', '127.0.0.1', '[::1]', '0.0.0.0']

/** Kunci perbandingan dedupe (fragmen dibuang, alias loopback disatukan); null bila URL tak valid. */
export function browserDedupeKey(raw: string): string | null {
  const p = parseBrowserUrl(raw)
  if (!p.ok) return null
  const u = new URL(p.url)
  const host = LOOPBACK_ALIASES.includes(u.hostname) ? 'localhost' : u.hostname
  return `${u.protocol}//${host}${u.port ? ':' + u.port : ''}${u.pathname}${u.search}`
}

const sizeOf = (n: PlanNode): Size => ({
  width: n.measured?.width ?? n.width ?? ANCHOR_FALLBACK_SIZE.width,
  height: n.measured?.height ?? n.height ?? ANCHOR_FALLBACK_SIZE.height,
})
const rectOf = (n: PlanNode): Rect => ({ ...n.position, ...sizeOf(n) })

/** Putuskan reuse (URL sama sudah ada), create (dengan posisi), atau invalid. Tanpa efek samping. */
export function planBrowserOpen(nodes: PlanNode[], req: OpenBrowserReq, newId: string, viewCenter: XYPosition): OpenPlan {
  const parsed = parseBrowserUrl(req.url)
  if (!parsed.ok) return { kind: 'invalid', reason: parsed.reason }
  const key = browserDedupeKey(parsed.url)
  const hit = nodes.find((n) => n.type === 'browser' && !!n.data?.url && browserDedupeKey(n.data.url) === key)
  if (hit) return { kind: 'reuse', nodeId: hit.id }
  const anchorNode = req.anchorNodeId ? nodes.find((n) => n.id === req.anchorNodeId) : undefined
  const position = placeBeside({
    anchor: anchorNode && rectOf(anchorNode),
    at: req.at,
    center: viewCenter,
    occupied: nodes.map(rectOf),
    size: BROWSER_OPEN_SIZE,
  })
  return { kind: 'create', nodeId: newId, url: parsed.url, position, size: BROWSER_OPEN_SIZE }
}
