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
}

/** Warna satu node di MiniMap: status agent berwarna (selesai = netral), selain itu netral. */
export function miniMapNodeColor(n: Node, statuses: Record<string, AgentStatus>): string {
  const s = statuses[n.id]
  return s ? STATUS_COLOR[s] : MINIMAP_NODE_NEUTRAL
}

/** Warna edge VS Code: garis netral (seperti garis nomor/indent), terpilih = `focusBorder`.
 *  Fallback ke token lama supaya tetap benar bila `--vscode-*` belum dipetakan. */
export const EDGE_STROKE = 'var(--vscode-editorLineNumber-foreground, var(--muted))'
export const EDGE_STROKE_SELECTED = 'var(--vscode-focusBorder, var(--accent))'
/** Tebal garis edge: 1px idle, 1.5px terpilih (kisaran VS Code 1-1.5px). */
const EDGE_WIDTH = 1
const EDGE_WIDTH_SELECTED = 1.5
/** `strokeWidth` kepala panah terpilih. Ia masuk ke id `<marker>` (React Flow menyusun id dari
 *  semua properti marker), dan `canvas-ui.css` mewarnai panah terpilih lewat `[id*='strokeWidth=2']`
 *  — ubah keduanya bersamaan. Warna marker sendiri `currentColor`: `var()` berspasi/berkoma tak aman
 *  dijadikan bagian id elemen. */
export const SELECTED_ARROW_STROKE = 2

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
export function decorateEdges(edges: Edge[], nodes: Node[]): Edge[] {
  const hidden = hiddenEdgeNodeIds(nodes as { id: string; data: { hideLinks?: boolean } }[])
  return edges.map((e) => {
    const arrow = {
      type: MarkerType.Arrow, color: 'currentColor', width: 10, height: 10,
      strokeWidth: e.selected ? SELECTED_ARROW_STROKE : 1,
    }
    const label = EDGE_LABEL[(e.data as { kind?: BridgeLink['kind'] } | undefined)?.kind ?? 'context']
    return {
      ...e,
      hidden: !edgeVisible(e, hidden),
      // Spread, jangan timpa: `data.kind` yang hilang membuat kabel file berlabel "context".
      data: { ...e.data, anchor: 'horizontal' },
      label: e.selected ? label.selected : label.idle,
      labelStyle: { fill: 'var(--vscode-descriptionForeground, var(--muted))', fontSize: 11 },
      labelBgStyle: { fill: 'var(--vscode-editor-background, var(--canvas-bg))', fillOpacity: 1 },
      style: {
        stroke: e.selected ? EDGE_STROKE_SELECTED : EDGE_STROKE,
        strokeWidth: e.selected ? EDGE_WIDTH_SELECTED : EDGE_WIDTH,
      },
      markerStart: arrow,
      markerEnd: arrow,
    }
  })
}

/** React Flow menyembunyikan edge yang salah satu ujungnya tidak punya handle sama sekali
 *  (`getEdgePosition` → null, error 008). Hanya AgentNode punya `<Handle>`; node files & editor
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
