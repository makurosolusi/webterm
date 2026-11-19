// Every user-facing string of the sticky note (Rule 15: labels live here, not inline in components).
import type { StickyColorId } from '../shared/sticky.palette'

export const STICKY_COLOR_NAME: Record<StickyColorId, string> = {
  salmon: 'Salmon', orange: 'Orange', gold: 'Gold', lemon: 'Lemon', green: 'Green',
  gray: 'Gray', pink: 'Pink', violet: 'Violet', blue: 'Blue', cyan: 'Cyan',
}

export const STICKY_TEXT = {
  kind: 'Sticky note',
  placeholder: 'Type a note',
  textareaLabel: 'Sticky note text',
  tagPlaceholder: 'Label',
  tagFieldLabel: 'Sticky note label',
  colorGroup: 'Sticky note color',
  menuAdd: 'Add sticky note',
  commandNew: 'Sticky: New Sticky Note',
  readOnly: 'The view is locked: unlock it to edit notes.',
  limit: (used: number, max: number) => `${used} / ${max}`,
  group: (text: string, color: string) => (text ? `Sticky note, ${color}: ${text}` : `Sticky note, ${color}, empty`),
} as const

/** Default hotkey of the new-sticky command: a modifier chord, so it can never fire while typing. */
export const STICKY_NEW_KEY = 'Mod+Alt+N'
/** localStorage key of the last color picked (a per-viewer convenience, not workspace data). */
export const STICKY_LAST_COLOR_KEY = 'webterm.sticky.lastColor'
