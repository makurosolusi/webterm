// Tab-layout chords, shared by the command registry and Monaco's forwarding (`editorChords`). A
// focused terminal hands them back to the app through the registry (`isAppChord`), like every other
// bound global command, so a rebinding takes effect there too.

export const TOGGLE_LAYOUT_KEY = 'Mod+Shift+L'
export const PREV_TAB_KEY = 'Mod+Shift+['
export const NEXT_TAB_KEY = 'Mod+Shift+]'
/** Ctrl+W is readline word-rubout and the browser's own close-tab, so only macOS gets the bare chord. */
export const closeTabKey = (isMac: boolean): string => (isMac ? 'Mod+W' : 'Mod+Alt+W')
