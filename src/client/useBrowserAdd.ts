// Jalan masuk "New Browser" untuk App: mengikat socket browser ke workspace aktif dan memulangkan
// penambah node HANYA bila server melapor fitur menyala (`undefined` = Dock/menu tidak menampilkan baris).
import { useCallback } from 'react'
import type { XYPosition } from '@xyflow/react'
import type { WsNode, Workspace } from '../shared/workspace'
import { useBrowserStatus } from './browser.feature'
import { setBrowserWorkspace } from './browser.stream'
import { randomId } from './randomId'

type AddFlowNode = (make: (n: number, ws: Workspace) => Omit<WsNode, 'x' | 'y'>, at?: XYPosition) => void

export function useBrowserAdd(addFlowNode: AddFlowNode, activeId: string | null, ready: boolean): ((at?: XYPosition) => void) | undefined {
  // Saat render, bukan di effect: effect anak (attach node browser) jalan SEBELUM effect induk, jadi
  // socket akan terbuka untuk workspace lama. Idempotent: id yang sama tidak melakukan apa-apa.
  setBrowserWorkspace(activeId ?? '')
  const enabled = useBrowserStatus(ready) !== null
  const add = useCallback((at?: XYPosition) => addFlowNode(() => ({ id: randomId(), kind: 'browser' }), at), [addFlowNode])
  return enabled ? add : undefined
}
