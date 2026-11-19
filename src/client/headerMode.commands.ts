// Header-mode commands in the shared registry (palette, shortcut dispatcher, Keyboard Shortcuts page).
import { useRegisterCommands, type Command } from './commandRegistry'
import { HEADER_MODES, setHeaderMode, toggleHeaderHidden, type HeaderMode } from './headerMode.store'

/** Hidden <-> Tabs. Free in-app (checked in headerMode.commands.test.ts); rebindable. */
export const TOGGLE_HEADER_KEY = 'Mod+Shift+H'
export const TOGGLE_HEADER_ID = 'view.header.toggle'

export const HEADER_MODE_LABEL: Record<HeaderMode, string> = { tabs: 'Tabs', hidden: 'Hidden' }

/** One command per mode plus the chord's toggle. Static: no App state is needed to run them. */
export const HEADER_MODE_COMMANDS: Command[] = [
  ...HEADER_MODES.map((mode): Command => ({ id: `view.header.${mode}`, label: `View: Header: ${HEADER_MODE_LABEL[mode]}`, run: () => setHeaderMode(mode) })),
  { id: TOGGLE_HEADER_ID, label: 'View: Toggle Header', defaultKey: TOGGLE_HEADER_KEY, run: toggleHeaderHidden },
]

/** Registers the header-mode commands while App is mounted. */
export function useHeaderModeCommands(): void {
  useRegisterCommands(HEADER_MODE_COMMANDS)
}
