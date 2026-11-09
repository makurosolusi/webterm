// Layers commands in the shared registry (copied from `tabLayout.commands.ts`): group the selected
// nodes, ungroup their groups. Default keys (Mod+G, Mod+Shift+G) are defined in commandRegistry.defaults.
import { useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import type { ReactFlowInstance } from '@xyflow/react'
import { useRegisterCommands, type Command } from './commandRegistry'
import { LAYERS_GROUP_KEY, LAYERS_UNGROUP_KEY } from './commandRegistry.defaults'
import { closestNodeRoot } from './nodeRoot'
import { createGroup, getTabLayout, ungroup } from './tabLayout.store'
import { groupsOfIds, selectedInOrder } from './layersPanel.model'

export const GROUP_ID = 'layers.group'
export const UNGROUP_ID = 'layers.ungroup'

/** Focus inside a node's content (terminal, editor, browser, ...) owns the keyboard: the chord is
 *  not ours there. Focus on the node wrapper itself (after a reveal) still counts as canvas. */
export function focusInsideNode(el: Element | null = document.activeElement): boolean {
  const root = closestNodeRoot(el)
  return !!root && root !== el
}

/** Group the selected nodes (list order); returns the new group id, or null. */
export function groupSelection(selected: () => string[]): string | null {
  const ids = selected()
  return ids.length ? createGroup(ids) : null
}

/** Ungroup every group holding a selected node. */
export function ungroupSelection(selected: () => string[]): void {
  for (const g of groupsOfIds(getTabLayout().tabs.groups, selected())) ungroup(g)
}

/** The two commands (pure; tests read them without React). `selected` = selected node ids in list order. */
export function layersCommands(selected: () => string[]): Command[] {
  const guard = (fn: () => void) => () => { if (!focusInsideNode()) fn() }
  return [
    { id: GROUP_ID, label: 'Layers: Group Selection', defaultKey: LAYERS_GROUP_KEY, run: guard(() => void groupSelection(selected)) },
    { id: UNGROUP_ID, label: 'Layers: Ungroup', defaultKey: LAYERS_UNGROUP_KEY, run: guard(() => ungroupSelection(selected)) },
  ]
}

/** Registers the Layers commands while mounted; reads the selection from `rf` at run time. */
export function useLayersCommands(rf: RefObject<ReactFlowInstance | null>): void {
  const ref = useRef(rf)
  ref.current = rf
  const list = useMemo(() => layersCommands(() => selectedInOrder(ref.current.current?.getNodes() ?? [], getTabLayout().tabs.order)), [])
  useRegisterCommands(list)
}
