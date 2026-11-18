// Inline rename for a rail tile: the same `WorkspaceTabRename` field as the header tab, in a popover
// anchored to the right of the tile (fixed position, so the group's scroll clipping never cuts it).
import { useLayoutEffect, useState, type RefObject } from 'react'
import { WorkspaceTabRename } from './WorkspaceTabRename'

/** Horizontal gap between the tile and its popover. */
const ANCHOR_GAP_PX = 6

export interface RailRenameProps {
  groupRef: RefObject<HTMLElement | null>
  id: string
  initial: string
  onCommit: (name: string) => void | Promise<unknown>
  onClose: () => void
}

export function RailRename({ groupRef, id, initial, onCommit, onClose }: RailRenameProps) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)
  useLayoutEffect(() => {
    const tile = [...(groupRef.current?.querySelectorAll<HTMLElement>('[data-ws-id]') ?? [])].find((el) => el.dataset.wsId === id)
    const r = tile?.getBoundingClientRect()
    setAt(r ? { top: r.top, left: r.right + ANCHOR_GAP_PX } : { top: 0, left: 0 })
  }, [groupRef, id])
  if (!at) return null
  return (
    <div className="ws-rail__rename" style={at}>
      <WorkspaceTabRename initial={initial} onCommit={onCommit} onClose={onClose} />
    </div>
  )
}
