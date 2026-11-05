// Satu pintu `openBrowserAt`: rencana (murni, browser.open.plan) -> buat/pakai-ulang node -> fit-view + fokus.
// `undefined` = flag browser mati di server, sehingga semua pemicu (menu link, drop) ikut tak muncul.
import { useCallback } from 'react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { Node, ReactFlowInstance } from '@xyflow/react'
import type { Workspace, WsNode } from '../shared/workspace'
import { planBrowserOpen, type OpenBrowserReq, type OpenResult, type PlanNode } from './browser.open.plan'
import type { Size } from './browser.open.place'
import { rectOfNode, revealNode as reveal } from './nodeReveal'
import { randomId } from './randomId'

type AddFlowNode = (make: (n: number, ws: Workspace) => Omit<WsNode, 'x' | 'y'>, at?: { x: number; y: number }) => void

export interface BrowserOpenDeps {
  enabled: boolean
  addFlowNode: AddFlowNode
  rf: RefObject<ReactFlowInstance | null>
  nodesRef: RefObject<Node[]>
  setNodes: Dispatch<SetStateAction<Node[]>>
  /** Ukuran BAWAAN settings: `addFlowNode` menghitung kiri-atas dari ini, bukan dari ukuran `make`. */
  defaultSize: Size
}

/** Pintu pembuka node browser untuk `NodeActions`; `undefined` bila fitur mati. Identitas stabil antar render. */
export function useBrowserOpen({ enabled, addFlowNode, rf, nodesRef, setNodes, defaultSize }: BrowserOpenDeps): ((req: OpenBrowserReq) => OpenResult) | undefined {
  const { width: dw, height: dh } = defaultSize
  const open = useCallback((req: OpenBrowserReq): OpenResult => {
    const inst = rf.current
    const center = inst?.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }) ?? { x: 0, y: 0 }
    const plan = planBrowserOpen(nodesRef.current as PlanNode[], req, randomId(), center)
    if (plan.kind === 'invalid') return { status: 'invalid', reason: plan.reason }

    if (plan.kind === 'reuse') {
      const id = plan.nodeId
      // Seleksi saja, tidak dipersist/undo: dedupe tidak menavigasi (lease agent / sesi pengguna aman).
      setNodes((prev) => {
        const next = prev.map((n) => (!!n.selected === (n.id === id) ? n : { ...n, selected: n.id === id }))
        nodesRef.current = next
        return next
      })
      const hit = nodesRef.current.find((n) => n.id === id)
      if (hit) reveal(inst, id, rectOfNode(hit))
      return { status: 'reused', nodeId: id }
    }

    const { nodeId, url, position, size } = plan
    // `at` = TITIK TENGAH menurut ukuran bawaan (addFlowNode mengurangi dw/2,dh/2), jadi pakai defaultSize, bukan `size`.
    const at = { x: position.x + dw / 2, y: position.y + dh / 2 }
    addFlowNode(() => ({ id: nodeId, kind: 'browser', url, width: size.width, height: size.height }), at)
    // Node baru belum ada di store sampai commit; rect-nya sudah diketahui dari rencana.
    requestAnimationFrame(() => reveal(rf.current, nodeId, { ...position, ...size }))
    return { status: 'created', nodeId }
  }, [addFlowNode, rf, nodesRef, setNodes, dw, dh])
  return enabled ? open : undefined
}
