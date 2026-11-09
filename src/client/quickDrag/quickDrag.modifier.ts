// Which held keys arm quick move & resize, per preset and platform (macOS ⌘, elsewhere Ctrl as `Mod`,
// the same split `tabLayout.keys.ts` and `browser.keys.ts` make).
import type { QuickDragPreset } from '../../shared/settings'

export interface ModifierState { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }

/** Exact chord per preset (extra modifiers reject, so other chords keep working). */
const CHORDS: Record<Exclude<QuickDragPreset, 'off'>, { mac: ModifierState; other: ModifierState }> = {
  cmdCtrl: {
    mac: { metaKey: true, ctrlKey: true, altKey: false, shiftKey: false },
    other: { metaKey: false, ctrlKey: true, altKey: true, shiftKey: false },
  },
  cmdShift: {
    mac: { metaKey: true, ctrlKey: false, altKey: false, shiftKey: true },
    other: { metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
  },
}

/** True when exactly the preset's modifiers are held; `off` never matches. */
export function quickDragHeld(e: ModifierState, preset: QuickDragPreset, isMac: boolean): boolean {
  if (preset === 'off') return false
  const want = CHORDS[preset]?.[isMac ? 'mac' : 'other']
  return !!want && e.metaKey === want.metaKey && e.ctrlKey === want.ctrlKey && e.altKey === want.altKey && e.shiftKey === want.shiftKey
}

/** Settings label of a preset on this platform. */
export function quickDragLabel(preset: QuickDragPreset, isMac: boolean): string {
  if (preset === 'off') return 'Off'
  if (preset === 'cmdShift') return isMac ? '⌘⇧ + drag' : 'Ctrl+Shift + drag'
  return isMac ? '⌘⌃ + drag' : 'Ctrl+Alt + drag'
}
