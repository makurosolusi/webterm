// Bawa node ke pandangan + fokus keyboard. Dipakai bersama pembuka browser (useBrowserOpen) dan
// pembuka file (useFilesOpen): "buka X" selalu harus mengantar pengguna ke X, termasuk saat X sudah ada.
import type { Node, ReactFlowInstance } from '@xyflow/react'
import {
  ANCHOR_FALLBACK_SIZE, FIT_DURATION_MS, FIT_MAX_ZOOM, FIT_MIN_ZOOM, FIT_PADDING, rectInView, type Rect,
} from './browser.open.place'

/** Rect FLOW sebuah node; ukuran fallback untuk node yang belum terukur. */
export const rectOfNode = (n: Node): Rect => ({
  ...n.position,
  width: n.measured?.width ?? n.width ?? ANCHOR_FALLBACK_SIZE.width,
  height: n.measured?.height ?? n.height ?? ANCHOR_FALLBACK_SIZE.height,
})

type RevealRf = Pick<ReactFlowInstance, 'getViewport' | 'fitView'>

/** Jadikan `nid` satu-satunya node terpilih. Seleksi saja (tidak dipersist); node yang tak berubah dipertahankan identitasnya. */
export const selectOnly = (rf: Pick<ReactFlowInstance, 'setNodes'>, nid: string): void =>
  rf.setNodes((prev) => prev.map((n) => (!!n.selected === (n.id === nid) ? n : { ...n, selected: n.id === nid })))

/** Bawa node ke pandangan (hanya bila tidak sepenuhnya terlihat) lalu fokuskan wrapper-nya, bukan isi node. */
export function revealNode(rf: RevealRf | null, id: string, rect: Rect): void {
  if (!rf) return
  const screen = { width: window.innerWidth, height: window.innerHeight }
  if (!rectInView(rect, rf.getViewport(), screen)) {
    void rf.fitView({ nodes: [{ id }], padding: FIT_PADDING, minZoom: FIT_MIN_ZOOM, maxZoom: FIT_MAX_ZOOM, duration: FIT_DURATION_MS })
  }
  // Dicari per atribut (bukan selector) agar id apa pun aman tanpa CSS.escape; ketikan tak langsung masuk halaman jauh.
  const el = Array.from(document.querySelectorAll<HTMLElement>('.react-flow__node')).find((e) => e.dataset.id === id)
  el?.focus({ preventScroll: true })
}
