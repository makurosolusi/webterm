// Dekorasi visual murni untuk canvas: warna node di MiniMap dan gaya edge context. Dipisah dari
// `App.tsx` supaya App tetap soal state/wiring saja — di sini tidak ada state, ref, atau IO.
import { MarkerType, Position } from '@xyflow/react'
import type { Edge, Node, NodeHandle } from '@xyflow/react'
import { hiddenEdgeNodeIds, edgeVisible } from './floatingEdge'
import type { AgentStatus, BridgeLink } from '../shared/workspace'

const ACCENT = '#0a84ff'
const STATUS_COLOR: Record<AgentStatus, string> = {
  working: '#d97757',
  waiting: '#ff9f0a',
  blocked: '#ff453a',
  done: '#98989d',
}

/** Warna satu node di MiniMap: status agent menang, lalu warna pilihan node, lalu aksen. */
export function miniMapNodeColor(n: Node, statuses: Record<string, AgentStatus>): string {
  if (n.type === 'terminal') return ACCENT
  const s = statuses[n.id]
  if (s) return STATUS_COLOR[s]
  return (n.data as { color?: string }).color ?? ACCENT
}

/** Label per jenis kabel. Kabel buka-file BUKAN context link — menyebutnya "context" adalah label
 *  bohong tentang apa yang dibaca agent. */
const EDGE_LABEL: Record<BridgeLink['kind'], { idle: string; selected: string }> = {
  context: { idle: '⇄ context', selected: '⇄ context — ⌫ to remove' },
  file: { idle: '↔ open', selected: '↔ open — ⌫ to remove' },
}

/** Edge yang benar-benar dirender: yang node ujungnya menyembunyikan link ditandai `hidden` (flag
 *  bawaan React Flow) dan sisanya diberi label + panah dua arah. Edge terpilih dibuat putih &
 *  lebih tebal supaya ⌫ jelas sasarannya.
 *
 *  Ditandai, BUKAN dibuang: `edges` di sini adalah yang dilihat store React Flow, jadi edge yang
 *  dibuang tidak terlihat oleh `deleteElements` — menghapus node-nya akan meninggalkan bridge
 *  yatim, dan `rf.getEdges()` di dalam node akan menyangka pasangannya belum terhubung. */
export function decorateEdges(edges: Edge[], nodes: Node[]): Edge[] {
  const hidden = hiddenEdgeNodeIds(nodes as { id: string; data: { hideLinks?: boolean } }[])
  return edges.map((e) => {
    const stroke = e.selected ? '#ffffff' : ACCENT
    const arrow = { type: MarkerType.ArrowClosed, color: stroke, width: 14, height: 14 }
    const label = EDGE_LABEL[(e.data as { kind?: BridgeLink['kind'] } | undefined)?.kind ?? 'context']
    return {
      ...e,
      hidden: !edgeVisible(e, hidden),
      // Spread, jangan timpa: `data.kind` yang hilang membuat kabel file berlabel "context".
      data: { ...e.data, anchor: 'horizontal' },
      label: e.selected ? label.selected : label.idle,
      labelStyle: { fill: stroke, fontSize: 11, fontWeight: 600 },
      labelBgStyle: { fill: '#1c1c1e', fillOpacity: 0.85 },
      style: { stroke, strokeWidth: e.selected ? 3.5 : 2 },
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
