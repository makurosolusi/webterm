// Keputusan "buka file dari file manager jadi node editor". Murni, tanpa DOM/React Flow: vitest
// webterm berjalan di node-env, jadi logikanya harus bisa dites di luar komponen.
import { bridgeExists } from './floatingEdge'
import type { BridgeLink } from '../shared/workspace'

/** EDITOR_SIZE nodeterm (`src/renderer/state/workspace.ts:77`). Node yang lahir dari `rf.addNodes`
 *  TIDAK lewat `addFlowNode`, jadi tidak kebagian default node workspace — tanpa ukuran eksplisit
 *  ia memakai fallback 400×300 `store.toFlow` dan isi file-nya nyaris tak terbaca. */
export const EDITOR_SIZE = { width: 660, height: 460 }

interface NodeLike { id: string; type?: string; data?: { filePath?: string; preview?: boolean } }
interface EdgeLike { source: string; target: string }

/** Id node editor yang SUDAH memegang `filePath`, atau null.
 *
 *  Sumber kebenaran dedupe adalah ADA/TIDAKNYA node editor, BUKAN kabelnya: kabel cuma penanda,
 *  jadi pengguna yang menghapus kabel saja tetap punya file yang terbuka dan tidak boleh
 *  mendapat jendela kedua. Sama seperti `openFile` nodeterm (`canvas/Canvas.tsx:5960`). */
export function openEditorFor(nodes: NodeLike[], filePath: string): string | null {
  return nodes.find((n) => n.type === 'editor' && n.data?.filePath === filePath)?.id ?? null
}

export interface OpenFilePlan {
  /** true = node editor sudah ada; sorot saja, jangan buat yang kedua. */
  focus: boolean
  /** true = `nodeId` adalah editor preview milik node files ini: ganti file-nya, jangan buat node. */
  swap: boolean
  nodeId: string
  /** Kabel yang harus dibuat, atau null kalau pasangan ini sudah terhubung. */
  edge: BridgeLink | null
}

/** Editor PREVIEW (VS Code: tab miring) yang dikabel dari `filesNodeId`, kabel terbaru menang; null bila tak ada.
 *  "Bersih" tidak perlu dicek terpisah: editan pertama mem-pin editor (`useEditorPreview`), jadi preview selalu bersih. */
export function previewEditorOf(nodes: NodeLike[], edges: EdgeLike[], filesNodeId: string): string | null {
  for (let i = edges.length - 1; i >= 0; i--) {
    const e = edges[i]
    if (e.source !== filesNodeId) continue
    const n = nodes.find((x) => x.id === e.target)
    if (n?.type === 'editor' && n.data?.preview === true) return n.id
  }
  return null
}

/**
 * Apa yang harus terjadi saat `filePath` dibuka dari node files `filesNodeId`: pakai node editor
 * yang sudah ada atau lahirkan `newNodeId`, dan pasang kabel penanda bila belum ada (termasuk saat
 * node-nya ada tapi kabelnya sudah dihapus pengguna). `preview` = buka satu-klik: editor preview yang
 * sudah dikabel ke node files ini dipakai ulang (`swap`) alih-alih melahirkan node baru.
 *
 * Id kabel mengikuti konvensi `bridge-<source>-<target>` supaya `bridgeExists` tetap jadi dedupe-nya.
 */
export function planFileOpen(
  nodes: NodeLike[],
  edges: EdgeLike[],
  filesNodeId: string,
  filePath: string,
  newNodeId: string,
  preview = false,
): OpenFilePlan {
  const open = openEditorFor(nodes, filePath)
  const reuse = open === null && preview ? previewEditorOf(nodes, edges, filesNodeId) : null
  const nodeId = open ?? reuse ?? newNodeId
  return {
    focus: open !== null,
    swap: reuse !== null,
    nodeId,
    edge: bridgeExists(edges, filesNodeId, nodeId)
      ? null
      : { id: `bridge-${filesNodeId}-${nodeId}`, source: filesNodeId, target: nodeId, kind: 'file' },
  }
}
