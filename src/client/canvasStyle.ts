// Dekorasi visual murni untuk canvas: warna node di MiniMap dan gaya edge context. Dipisah dari
// `App.tsx` supaya App tetap soal state/wiring saja — di sini tidak ada state, ref, atau IO.
import { MarkerType, Position } from '@xyflow/react'
import type { Edge, Node, NodeHandle } from '@xyflow/react'
import { hiddenEdgeNodeIds, edgeVisible } from './floatingEdge'
import type { AgentStatus, BridgeLink } from '../shared/workspace'

/** Node minimap netral seperti blok kode minimap VS Code; hanya status agent yang berwarna.
 *  Warna pilihan node (`data.color`) sengaja tidak dipakai: ia hanya penanda kecil di chrome node. */
export const MINIMAP_NODE_NEUTRAL = 'var(--vscode-editorLineNumber-foreground)'
const STATUS_COLOR: Record<AgentStatus, string> = {
  working: 'var(--state-working)',
  waiting: 'var(--state-warning)',
  blocked: 'var(--state-attention)',
  done: MINIMAP_NODE_NEUTRAL,
  failed: 'var(--state-attention)',
  stopped: MINIMAP_NODE_NEUTRAL,
}

/** Warna satu node di MiniMap: status agent berwarna (selesai = netral), selain itu netral. */
export function miniMapNodeColor(n: Node, statuses: Record<string, AgentStatus>): string {
  const s = statuses[n.id]
  return s ? STATUS_COLOR[s] : MINIMAP_NODE_NEUTRAL
}

/** Warna edge: `--edge-color` (Settings › Cable color, dipasang di root canvas) atau foreground editor
 *  ~70% opaque supaya terbaca di atas latar kustom; terpilih = `focusBorder`. Fallback ke token lama
 *  bila `--vscode-*` belum dipetakan. `canvas-ui.css` memakai ekspresi yang sama untuk
 *  `.react-flow__marker` — ubah keduanya bersamaan. */
export const EDGE_STROKE_OPACITY_PCT = 70
export const EDGE_STROKE = `var(--edge-color, color-mix(in srgb, var(--vscode-editor-foreground, var(--muted)) ${EDGE_STROKE_OPACITY_PCT}%, transparent))`
export const EDGE_STROKE_SELECTED = 'var(--vscode-focusBorder, var(--accent))'
/** Tebal garis edge default (Settings › Cable thickness); terpilih dan hover masing-masing menambah
 *  `EDGE_WIDTH_EXTRA` (hover lewat `--edge-hover-extra` di `canvas-ui.css`). */
export const EDGE_WIDTH = 2
export const EDGE_WIDTH_EXTRA = 1
/** Kepala panah (px) dan `strokeWidth` panah idle. */
export const ARROW_SIZE = 13
export const IDLE_ARROW_STROKE = 1
/** Area klik/hover kabel (px), jauh lebih lebar dari garisnya supaya mudah dibidik. */
export const EDGE_INTERACTION_WIDTH = 24
/** `strokeWidth` kepala panah terpilih. Ia masuk ke id `<marker>` (React Flow menyusun id dari
 *  semua properti marker), dan `canvas-ui.css` mewarnai panah terpilih lewat `[id*='strokeWidth=2']`
 *  — ubah keduanya bersamaan, dan jaga agar tetap berbeda dari `IDLE_ARROW_STROKE`. Warna marker
 *  sendiri `currentColor`: `var()` berspasi/berkoma tak aman dijadikan bagian id elemen. */
export const SELECTED_ARROW_STROKE = 2

/** Kabel yang sedang ditarik: warna dan tebal sama dengan kabel idle. */
export const connectionLineStyle = (width: number = EDGE_WIDTH) => ({ stroke: EDGE_STROKE, strokeWidth: width })

/** Label per jenis kabel. Kabel buka-file BUKAN context link — menyebutnya "context" adalah label
 *  bohong tentang apa yang dibaca agent. */
const EDGE_LABEL: Record<BridgeLink['kind'], { idle: string; selected: string }> = {
  context: { idle: '⇄ context', selected: '⇄ context — ⌫ to remove' },
  file: { idle: '↔ open', selected: '↔ open — ⌫ to remove' },
}

/** Edge yang benar-benar dirender: yang node ujungnya menyembunyikan link ditandai `hidden` (flag
 *  bawaan React Flow) dan sisanya diberi label + panah dua arah. Edge terpilih memakai `focusBorder` &
 *  lebih tebal supaya ⌫ jelas sasarannya.
 *
 *  Ditandai, BUKAN dibuang: `edges` di sini adalah yang dilihat store React Flow, jadi edge yang
 *  dibuang tidak terlihat oleh `deleteElements` — menghapus node-nya akan meninggalkan bridge
 *  yatim, dan `rf.getEdges()` di dalam node akan menyangka pasangannya belum terhubung. */
export function decorateEdges(edges: Edge[], nodes: Node[], width: number = EDGE_WIDTH): Edge[] {
  const hidden = hiddenEdgeNodeIds(nodes as { id: string; data: { hideLinks?: boolean } }[])
  return edges.map((e) => {
    const arrow = {
      type: MarkerType.Arrow, color: 'currentColor', width: ARROW_SIZE, height: ARROW_SIZE,
      strokeWidth: e.selected ? SELECTED_ARROW_STROKE : IDLE_ARROW_STROKE,
    }
    const label = EDGE_LABEL[(e.data as { kind?: BridgeLink['kind'] } | undefined)?.kind ?? 'context']
    return {
      ...e,
      hidden: !edgeVisible(e, hidden),
      // Spread, jangan timpa: `data.kind` yang hilang membuat kabel file berlabel "context".
      data: { ...e.data, anchor: 'horizontal' },
      label: e.selected ? label.selected : label.idle,
      labelStyle: { fill: 'var(--vscode-descriptionForeground, var(--muted))', fontSize: 11 },
      labelBgStyle: { fill: 'var(--canvas-bg)', fillOpacity: 1 },
      style: {
        stroke: e.selected ? EDGE_STROKE_SELECTED : EDGE_STROKE,
        strokeWidth: e.selected ? width + EDGE_WIDTH_EXTRA : width,
      },
      interactionWidth: EDGE_INTERACTION_WIDTH,
      markerStart: arrow,
      markerEnd: arrow,
    }
  })
}

/** React Flow menyembunyikan edge yang salah satu ujungnya tidak punya handle sama sekali
 *  (`getEdgePosition` → null, error 008). Hanya AgentNode & BrowserNode punya `<Handle>`; node files & editor
 *  sengaja tidak, karena kabel buka-file dibuat otomatis, bukan dengan drag. Stub ini memberi
 *  handle bounds TANPA elemen yang bisa ditarik pengguna. Koordinatnya tidak dipakai: `ContextEdge`
 *  menghitung titik sambungnya sendiri dari rect node. */
const LINK_STUB: NodeHandle[] = [
  { type: 'source', position: Position.Right, x: 0, y: 0 },
  { type: 'target', position: Position.Left, x: 0, y: 0 },
]

export function withLinkHandles(n: Node): Node {
  if (n.handles || (n.type !== 'files' && n.type !== 'editor')) return n
  return { ...n, handles: LINK_STUB }
}
