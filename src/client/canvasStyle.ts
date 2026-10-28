// Dekorasi visual murni untuk canvas: warna node di MiniMap dan gaya edge context. Dipisah dari
// `App.tsx` supaya App tetap soal state/wiring saja — di sini tidak ada state, ref, atau IO.
import { MarkerType } from '@xyflow/react'
import type { Edge, Node } from '@xyflow/react'
import { hiddenEdgeNodeIds, edgeVisible } from './floatingEdge'
import type { AgentStatus } from '../shared/workspace'

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

/** Edge yang benar-benar dirender: yang node ujungnya menyembunyikan link dibuang, sisanya diberi
 *  label + panah dua arah. Edge terpilih dibuat putih & lebih tebal supaya ⌫ jelas sasarannya. */
export function decorateEdges(edges: Edge[], nodes: Node[]): Edge[] {
  const hidden = hiddenEdgeNodeIds(nodes as { id: string; data: { hideLinks?: boolean } }[])
  return edges.filter((e) => edgeVisible(e, hidden)).map((e) => {
    const stroke = e.selected ? '#ffffff' : ACCENT
    const arrow = { type: MarkerType.ArrowClosed, color: stroke, width: 14, height: 14 }
    return {
      ...e,
      data: { anchor: 'horizontal' },
      label: e.selected ? '⇄ context — ⌫ to remove' : '⇄ context',
      labelStyle: { fill: stroke, fontSize: 11, fontWeight: 600 },
      labelBgStyle: { fill: '#1c1c1e', fillOpacity: 0.85 },
      style: { stroke, strokeWidth: e.selected ? 3.5 : 2 },
      markerStart: arrow,
      markerEnd: arrow,
    }
  })
}
