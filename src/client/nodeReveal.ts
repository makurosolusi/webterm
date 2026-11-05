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

type RevealRf = Pick<ReactFlowInstance, 'getViewport' | 'fitView'> & Partial<Pick<ReactFlowInstance, 'getNode'>>

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
export function revealInTabs(id: string, kind?: string): void {
  if (kind !== undefined && !isTabKind(kind as WsNodeKind)) setFilesPanelOpen(true)
  else {
    activateTab(id)
    // Node baru belum direkonsiliasi ke `order` saat dipanggil; coba lagi sekali setelah render.
    if (!getTabLayout().tabs.order.includes(id)) requestAnimationFrame(() => activateTab(id))
  }
  requestAnimationFrame(() => focusNodeRoot(id))
}

/** Bawa node ke pandangan (hanya bila tidak sepenuhnya terlihat) lalu fokuskan wrapper-nya, bukan isi node. Mode tab: aktifkan tab, tanpa fitView. */
export function revealNode(rf: RevealRf | null, id: string, rect: Rect): void {
  if (getTabLayout().mode === 'tabs') return revealInTabs(id, rf?.getNode?.(id)?.type)
  if (!rf) return
  const screen = { width: window.innerWidth, height: window.innerHeight }
  if (!rectInView(rect, rf.getViewport(), screen)) {
    void rf.fitView({ nodes: [{ id }], padding: FIT_PADDING, minZoom: FIT_MIN_ZOOM, maxZoom: FIT_MAX_ZOOM, duration: FIT_DURATION_MS })
  }
  focusNodeRoot(id)
}
