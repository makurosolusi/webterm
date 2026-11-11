// Toggle Output's default chord. The command itself lives in the registry (`outputCommands.ts`), so
// a focused terminal hands it back through `isAppChord` and the user can rebind it.

/** ⇧⌘U (macOS) / Ctrl+Shift+U, as in VS Code. */
export const OUTPUT_TOGGLE_KEY = 'Mod+Shift+U'

/** Platform-aware label for menus and tooltips. */
export function outputShortcutLabel(isMac: boolean): string {
  return isMac ? '⇧⌘U' : 'Ctrl+Shift+U'
}
