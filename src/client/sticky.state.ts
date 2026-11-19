// Client-only sticky state that is not workspace data: the last color picked (per viewer) and the
// "this node was just created, open it for typing" hand-off from the creator to the node.
import { DEFAULT_STICKY_COLOR, isStickyColor, type StickyColorId } from '../shared/sticky.palette'
import { STICKY_LAST_COLOR_KEY } from './sticky.labels'

/** The color the next sticky is born with: the last one picked, else the default. Storage may be blocked or empty. */
export function getLastStickyColor(): StickyColorId {
  try {
    const v = localStorage.getItem(STICKY_LAST_COLOR_KEY)
    return isStickyColor(v) ? v : DEFAULT_STICKY_COLOR
  } catch {
    return DEFAULT_STICKY_COLOR // private window / blocked site data: the convenience is simply off
  }
}

export function setLastStickyColor(color: StickyColorId): void {
  try {
    localStorage.setItem(STICKY_LAST_COLOR_KEY, color)
  } catch {
    // Same as above: the pick still applies to the notes, only the memory for the next one is lost.
  }
}

// Ids whose first mount opens the editor. Peeked on mount and cleared by an effect, so a StrictMode double render keeps it.
const wantsEdit = new Set<string>()
export const requestStickyEdit = (id: string): void => { wantsEdit.add(id) }
export const peekStickyEdit = (id: string): boolean => wantsEdit.has(id)
export const clearStickyEdit = (id: string): void => { wantsEdit.delete(id) }
