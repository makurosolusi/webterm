import { createContext, useContext } from 'react'
import type { OpenBrowserReq, OpenResult } from './browser.open.plan'

export type NodeActions = {
  /** Node mencetak session uuid-nya sendiri (atau restart) dan perlu dipersist ke node itu. */
  onSession: (nodeId: string, uuid: string) => void
  onToggleHideLinks: (nodeId: string) => void
  /** Buka URL di node browser; undefined = flag browser mati (pemicu tidak boleh menampilkan aksi). Tanpa default. */
  openBrowserAt?: (req: OpenBrowserReq) => OpenResult
}

/**
 * Callback level-App untuk node, lewat context alih-alih lewat `data` node. Menyuntikkannya ke
 * `data` berarti App mencetak objek `data` baru untuk tiap node agent setiap kali `nodes` berubah
 * — yaitu pada SETIAP tick drag — sehingga pembanding `memo` pada komponen node selalu gagal.
 * Hanya callback yang pindah: `hideLinks` tetap di `data` karena ia state yang dipersist.
 *
 * Default no-op supaya komponen node yang dirender di luar provider (tes, storybook) tidak meledak.
 */
const NodeActionsContext = createContext<NodeActions>({ onSession: () => {}, onToggleHideLinks: () => {} })

export const NodeActionsProvider = NodeActionsContext.Provider

export function useNodeActions(): NodeActions {
  return useContext(NodeActionsContext)
}
