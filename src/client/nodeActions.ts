import { createContext, useContext } from 'react'
import type { OpenBrowserReq, OpenResult } from './browser.open.plan'
import type { HandleSpawners } from './handleMenu.model'
import type { AddSkillResult, AddSkillTarget, SkillRef } from './skillNode.add'

export type NodeActions = {
  /** Node mencetak session uuid-nya sendiri (atau restart) dan perlu dipersist ke node itu. */
  onSession: (nodeId: string, uuid: string) => void
  onToggleHideLinks: (nodeId: string) => void
  /** Buka URL di node browser; undefined = flag browser mati (pemicu tidak boleh menampilkan aksi). Tanpa default. */
  openBrowserAt?: (req: OpenBrowserReq) => OpenResult
  /** Active workspace id (canvas wallpaper resolves its per-workspace override with it). */
  workspaceId?: string | null
  /** Node spawners for the handle menu (handleMenu.hook.tsx); absent = the menu stays closed. */
  spawn?: HandleSpawners
  /** Opens a skill-author chat node (edit `target`, or a new skill) and returns its node id; absent = Claude disabled. */
  openSkillAuthor?: (target?: string) => string
  /** Adds a skill node to the active board: with no `target`, cabled to the one selected Claude agent when there is exactly one; absent = no board provider. */
  addSkillNode?: (skill: SkillRef, target?: AddSkillTarget) => AddSkillResult
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
