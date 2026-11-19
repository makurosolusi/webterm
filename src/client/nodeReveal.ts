// Bawa node ke pandangan + fokus keyboard. Dipakai bersama pembuka browser (useBrowserOpen) dan
// pembuka file (useFilesOpen): "buka X" selalu harus mengantar pengguna ke X, termasuk saat X sudah ada.
import type { Node, ReactFlowInstance } from '@xyflow/react'
import { isTabKind } from '../shared/tabLayout.schema'
import type { WsNodeKind } from '../shared/workspace.shape'
import { findNodeRoot } from './nodeRoot'
import { activateTab, getTabLayout, setFilesPanelOpen } from './tabLayout.store'
import {
  ANCHOR_FALLBACK_SIZE, FIT_DURATION_MS, FIT_MAX_ZOOM, FIT_MIN_ZOOM, FIT_PADDING, rectInView, type Rect,
} from './browser.open.place'

/** Rect FLOW sebuah node; ukuran fallback untuk node yang belum terukur. */
export const rectOfNode = (n: Node): Rect => ({
  ...n.position,
  width: n.measured?.width ?? n.width ?? ANCHOR_FALLBACK_SIZE.width,
  height: n.measured?.height ?? n.height ?? ANCHOR_FALLBACK_SIZE.height,
})

export type RevealRf = Pick<ReactFlowInstance, 'getViewport' | 'fitView'> & Partial<Pick<ReactFlowInstance, 'getNode'>>

/** Jadikan `nid` satu-satunya node terpilih. Seleksi saja (tidak dipersist); node yang tak berubah dipertahankan identitasnya. */
export const selectOnly = (rf: Pick<ReactFlowInstance, 'setNodes'>, nid: string): void =>
  rf.setNodes((prev) => prev.map((n) => (!!n.selected === (n.id === nid) ? n : { ...n, selected: n.id === nid })))

/** Fokuskan root node `id` (tanpa scroll). Pane tab belum tentu fokusable, jadi diberi tabindex bila perlu. */
function focusNodeRoot(id: string): void {
  const el = findNodeRoot(id)
  if (el && el.hasAttribute('data-tab-node') && !el.hasAttribute('tabindex')) el.tabIndex = -1
  el?.focus({ preventScroll: true })
}

/**
 * Mode tab: tampilkan node tanpa menyentuh canvas. Tab diaktifkan; node Files (bukan tab) membuka
 * panel Files. `kind` kosong = anggap tab. Fokus ditunda satu frame sampai pane aktif ter-render.
 */
export function revealInTabs(id: string, kind?: string, focus = true): void {
  // Files docks as a panel; a canvas-only kind (sticky) has no tab view, so tab mode has nothing to show for it.
  if (kind === 'files') setFilesPanelOpen(true)
  else if (kind === undefined || isTabKind(kind as WsNodeKind)) {
    activateTab(id)
    // Node baru belum direkonsiliasi ke `order` saat dipanggil; coba lagi sekali setelah render.
    if (!getTabLayout().tabs.order.includes(id)) requestAnimationFrame(() => activateTab(id))
  }
  if (focus) requestAnimationFrame(() => focusNodeRoot(id))
}

/** Zoom below which a node's text is too small to read (guess: ~0.6 shows terminal text legibly; tune from use). */
export const FOLLOW_MIN_READABLE_ZOOM = 0.6

const prefersReducedMotion = (): boolean => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Bawa node ke pandangan (hanya bila tidak sepenuhnya terlihat) lalu fokuskan wrapper-nya, bukan isi node. Mode tab: aktifkan tab, tanpa fitView.
 *  `focus: false` (buka dari Files sambil tetap di tree): kamera boleh pindah, fokus keyboard tetap di tempatnya.
 *  `alongside`: node yang harus ikut terlihat saat kamera pindah (Files yang sedang diklik pengguna).
 *  `zoomToReadable`: node yang terlihat tapi terlalu kecil (zoom < FOLLOW_MIN_READABLE_ZOOM) juga di-fit.
 *  Resolves when the camera animation ends (at once when the camera did not move). */
export async function revealNode(
  rf: RevealRf | null, id: string, rect: Rect,
  { focus = true, alongside, zoomToReadable = false }: { focus?: boolean; alongside?: string; zoomToReadable?: boolean } = {},
): Promise<void> {
  if (getTabLayout().mode === 'tabs') return revealInTabs(id, rf?.getNode?.(id)?.type, focus)
  if (!rf) return
  // Viewport React Flow relatif terhadap PANE, bukan jendela: dengan sidebar terbuka, ukuran jendela
  // menganggap node di balik tepi kanan pane masih terlihat. Pane 0×0 = belum ada layout (jsdom).
  const pane = document.querySelector('.react-flow')?.getBoundingClientRect()
  const screen = pane?.width ? { width: pane.width, height: pane.height } : { width: window.innerWidth, height: window.innerHeight }
  const vp = rf.getViewport()
  const moves = !rectInView(rect, vp, screen) || (zoomToReadable && vp.zoom < FOLLOW_MIN_READABLE_ZOOM)
  if (focus) focusNodeRoot(id)
  if (!moves) return
  await rf.fitView({
    nodes: alongside ? [{ id }, { id: alongside }] : [{ id }], padding: FIT_PADDING, minZoom: FIT_MIN_ZOOM, maxZoom: FIT_MAX_ZOOM,
    duration: prefersReducedMotion() ? 0 : FIT_DURATION_MS,
  })
}
