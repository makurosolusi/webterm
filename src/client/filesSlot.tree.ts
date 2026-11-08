// Tree menu rows of the Files node: "Open in Browser" for an .html file (create/reuse a browser node via
// `openBrowserAt`, the file served by the fs `raw` verb) and "Collapse All". Its own slot (`treeSlot`);
// `openBrowserAt` is a hook value, so `useTreeRows` parks it per node for `treeRows` (plain function,
// called at menu time).
import { useEffect } from 'react'
import { childPath } from './fileBrowse'
import { codicon } from './FilesMenu'
import type { FilesSlot, FilesSlotCtx, SlotMenuRow } from './filesSlots'
import { rawUrl } from './fsClient'
import { URL_ERROR_TEXT } from './browser.uxText'
import { useNodeActions, type NodeActions } from './nodeActions'

export const TREE_TEXT = { collapseAll: 'Collapse All', openInBrowser: 'Open in Browser' } as const

const openers = new Map<string, NonNullable<NodeActions['openBrowserAt']>>()

export const isHtml = (name: string): boolean => /\.html?$/i.test(name)

/** Keep node `nodeId`'s browser opener for `treeRows`; absent when the browser feature is off. */
export function useTreeRows(nodeId: string): void {
  const { openBrowserAt } = useNodeActions()
  useEffect(() => {
    if (!openBrowserAt) return
    openers.set(nodeId, openBrowserAt)
    return () => { openers.delete(nodeId) }
  }, [nodeId, openBrowserAt])
}

export function treeRows(ctx: FilesSlotCtx): SlotMenuRow[] {
  const rows: SlotMenuRow[] = []
  const open = openers.get(ctx.nodeId)
  const one = ctx.selection.length === 1 ? ctx.entries.find((e) => e.name === ctx.selection[0]) : undefined
  if (open && one && !one.dir && isHtml(one.name)) {
    rows.push({
      label: TREE_TEXT.openInBrowser, icon: codicon('globe'),
      onClick: () => {
        const url = new URL(rawUrl(childPath(ctx.cwd, one.name)), window.location.origin).href
        const r = open({ url, anchorNodeId: ctx.nodeId })
        if (r.status === 'invalid') ctx.notify({ kind: 'error', text: URL_ERROR_TEXT[r.reason] })
      },
    })
  }
  if (ctx.expanded.size > 0) rows.push({ label: TREE_TEXT.collapseAll, icon: codicon('collapse-all'), onClick: () => ctx.collapseAll() })
  return rows
}

/** Slot: tree menu rows (Collapse All, Open in Browser). */
export const treeSlot: FilesSlot = { id: 'tree', useSlot: (ctx) => useTreeRows(ctx.nodeId), menu: treeRows }
