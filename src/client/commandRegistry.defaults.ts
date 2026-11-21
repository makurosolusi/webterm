// webterm's built-in commands. Labels and default keys follow VS Code where a counterpart exists
// (Go to File ⌘P, Find in Files ⇧⌘F, Open Settings ⌘,, New Terminal ⌃⇧`). `FIXED_COMMANDS` are
// shortcuts other surfaces own and that cannot be rebound (Monaco save, xterm, React Flow, Clean
// View); `SURFACE_COMMANDS` are rebindable but dispatched by their own surface through
// `commandMatches`. Both live here so the overlay is generated from one list and conflicts are
// checked against them.
import { openProfileSpawn } from './browserProfile.spawn'
import { PROFILE_TEXT } from './browserProfile.text'
import { useMemo, useRef } from 'react'
import { registerCommands, useRegisterCommands, type Command } from './commandRegistry'
import { openSetup } from './setup/setup.open'
import { startScreenshot } from './screenshot/ui/screenshot.start'
import { SCREENSHOT_COMMAND_ID, SCREENSHOT_COMMAND_LABEL } from './screenshot/ui/shot.ui.text'
import { STICKY_NEW_KEY, STICKY_TEXT } from './sticky.labels'
import { isMacPlatform } from './terminalKeys.platform'

// Chrome's back/forward: ⌘[ / ⌘] on macOS, Alt+Left / Alt+Right elsewhere (`browser.keys.ts`).
const IS_MAC = isMacPlatform()

export const FIXED_COMMANDS: Command[] = [
  { id: 'editor.save', label: 'File: Save', defaultKey: 'Mod+S', scope: 'editor', when: 'Editor node focused', fixed: true },
  { id: 'terminal.newline', label: 'Terminal: Insert Newline Without Sending', defaultKey: 'Shift+Enter', scope: 'terminal', fixed: true },
  { id: 'browser.focusUrl', label: 'Browser: Focus Address Bar', defaultKey: 'Mod+L', scope: 'browser', fixed: true },
  { id: 'browser.reload', label: 'Browser: Reload', defaultKey: 'Mod+R', scope: 'browser', fixed: true },
  { id: 'browser.hardReload', label: 'Browser: Hard Reload', defaultKey: 'Mod+Shift+R', scope: 'browser', fixed: true },
  { id: 'browser.back', label: 'Browser: Back', defaultKey: IS_MAC ? 'Mod+[' : 'Alt+ArrowLeft', scope: 'browser', fixed: true },
  { id: 'browser.forward', label: 'Browser: Forward', defaultKey: IS_MAC ? 'Mod+]' : 'Alt+ArrowRight', scope: 'browser', fixed: true },
  { id: 'browser.zoomIn', label: 'Browser: Zoom In Page', defaultKey: 'Mod+=', scope: 'browser', fixed: true },
  { id: 'browser.zoomOut', label: 'Browser: Zoom Out Page', defaultKey: 'Mod+-', scope: 'browser', fixed: true },
  { id: 'browser.zoomReset', label: 'Browser: Reset Page Zoom', defaultKey: 'Mod+0', scope: 'browser', fixed: true },
  { id: 'browser.zoomPinch', label: 'Browser: Zoom Page', gesture: 'Ctrl+scroll or pinch', scope: 'browser', fixed: true },
  { id: 'browser.stop', label: 'Browser: Stop Loading', defaultKey: 'Escape', scope: 'browser', when: 'Browser node loading a page', fixed: true },
  { id: 'files.quickOpen', label: 'Files: Go to File in This Folder', defaultKey: 'Mod+P', scope: 'files', when: 'Files node focused', fixed: true },
  // Escape hatch out of a chrome-less screen: fixed, so no setting or rebinding can lock the user in.
  { id: 'view.cleanView', label: 'View: Toggle Clean View', defaultKey: 'Mod+.', fixed: true, hidden: true },
  { id: 'canvas.deleteSelection', label: 'Canvas: Delete Selected Nodes or Edges', defaultKey: 'Backspace', scope: 'canvas', fixed: true },
  { id: 'canvas.deleteSelection.alt', label: 'Canvas: Delete Selected Nodes or Edges', defaultKey: 'Delete', scope: 'canvas', fixed: true },
  { id: 'canvas.unlinkEdge', label: 'Canvas: Remove Context Link', gesture: 'Double-click edge', scope: 'canvas', fixed: true },
  { id: 'workbench.closeOverlay', label: 'Close Overlay, Settings, or Filter', defaultKey: 'Escape', scope: 'canvas', fixed: true },
]

/** Rebindable, scoped; the surface named in `when` matches its keydowns via `commandMatches`. */
export const SURFACE_COMMANDS: Command[] = [
  { id: 'editor.togglePreview', label: 'Markdown: Toggle Preview', defaultKey: 'Mod+M', scope: 'editor', when: 'Pointer over a Markdown editor node' },
  { id: 'editor.toggleWordWrap', label: 'View: Toggle Word Wrap', defaultKey: 'Alt+Z', scope: 'editor', when: 'Editor or diff node focused' },
  { id: 'terminal.fontZoomIn', label: 'Terminal: Zoom In Font', defaultKey: 'Mod+=', scope: 'terminal', when: 'Terminal focused', setting: 'terminalFontZoomKeys' },
  { id: 'terminal.fontZoomOut', label: 'Terminal: Zoom Out Font', defaultKey: 'Mod+-', scope: 'terminal', when: 'Terminal focused', setting: 'terminalFontZoomKeys' },
  { id: 'terminal.fontZoomReset', label: 'Terminal: Reset Font Size', defaultKey: 'Mod+0', scope: 'terminal', when: 'Terminal focused', setting: 'terminalFontZoomKeys' },
  { id: 'browser.toggleConsole', label: 'Browser: Toggle Console', defaultKey: 'Mod+Alt+J', scope: 'browser', when: 'Browser node focused' },
]

// Static facts, not tied to App's lifetime: registered once on import so the overlay lists them
// even where App is not mounted (and an App unmount cannot drop them).
registerCommands([...FIXED_COMMANDS, ...SURFACE_COMMANDS])

/** Figma's ⇧⌘\ (show/hide UI) for the left side bar (Layers + Sessions). */
export const SIDE_BAR_KEY = 'Mod+Shift+\\'
/** Figma's group / ungroup chords, used by the Layers commands (`layers.commands.ts`). */
export const LAYERS_GROUP_KEY = 'Mod+G'
export const LAYERS_UNGROUP_KEY = 'Mod+Shift+G'

export interface AppCommandDeps {
  openOmnibox: () => void
  openQuickOpen: () => void
  openFindInFiles: () => void
  openShortcuts: () => void
  openSettings: () => void
  newTerminal: () => void
  newFiles: () => void
  newBrowser?: () => void
  /** Absent until the board wires `onAddDiff`: no command without a handler. */
  newDiff?: () => void
  /** Absent until the board wires `onAddSticky`: no command without a handler. */
  newSticky?: () => void
  fitView: () => void
  /** Maximize/restore the focused (or the one selected) node inside the canvas area. */
  toggleMaximizeNode: () => void
  toggleSessions: () => void
  toggleChat: () => void
  toggleSecondarySideBar: () => void
  toggleBoard: () => void
}

/** The global command list for `deps` (pure; tests read it without React). */
export function appCommands(d: AppCommandDeps): Command[] {
  return [
    { id: 'workbench.omnibox', label: 'Go to Anything (nodes, files, URLs, agents, commands)', defaultKey: 'Mod+K', run: d.openOmnibox, hidden: true },
    { id: 'workbench.quickOpen', label: 'Go to File…', defaultKey: 'Mod+P', run: d.openQuickOpen },
    { id: 'workbench.findInFiles', label: 'Search: Find in Files', defaultKey: 'Mod+Shift+F', run: d.openFindInFiles },
    { id: 'workbench.keybindings', label: 'Preferences: Keyboard Shortcuts', run: d.openShortcuts },
    { id: 'workbench.settings', label: 'Preferences: Open Settings', defaultKey: 'Mod+,', run: d.openSettings },
    { id: 'workbench.setup', label: 'Setup: Open', run: () => openSetup() },
    { id: 'terminal.new', label: 'Terminal: New Terminal', defaultKey: 'Ctrl+Shift+`', run: d.newTerminal },
    { id: 'files.new', label: 'Explorer: New Files Node', run: d.newFiles },
    ...(d.newBrowser ? [
      { id: 'browser.new', label: 'Browser: New Browser Node', run: d.newBrowser },
      { id: 'browser.newWithProfile', label: `Browser: ${PROFILE_TEXT.withProfile}`, run: () => openProfileSpawn('one') },
      { id: 'browser.openForEachProfile', label: `Browser: ${PROFILE_TEXT.forEach}`, run: () => openProfileSpawn('each') },
    ] : []),
    ...(d.newDiff ? [{ id: 'diff.new', label: 'Diff: New Diff Node (working changes)', run: d.newDiff }] : []),
    ...(d.newSticky ? [{ id: 'sticky.new', label: STICKY_TEXT.commandNew, defaultKey: STICKY_NEW_KEY, run: d.newSticky }] : []),
    // Mod+Shift+S: Save-As's chord family, free of every other binding and not a browser/OS capture key (those are ⌘⇧3/4/5 and Win+⇧S); the overlay itself uses Mod+S/Mod+C.
    { id: SCREENSHOT_COMMAND_ID, label: SCREENSHOT_COMMAND_LABEL, defaultKey: 'Mod+Shift+S', run: startScreenshot },
    { id: 'view.fit', label: 'View: Fit Canvas', run: d.fitView },
    { id: 'view.toggleMaximizeNode', label: 'View: Toggle Maximize Node', run: d.toggleMaximizeNode },
    { id: 'view.sessions', label: 'View: Toggle Side Bar', defaultKey: SIDE_BAR_KEY, run: d.toggleSessions },
    { id: 'view.chat', label: 'View: Toggle Chat', run: d.toggleChat },
    { id: 'view.secondarySideBar', label: 'View: Toggle Secondary Side Bar (Central: Chat, Control)', defaultKey: 'Mod+Alt+B', run: d.toggleSecondarySideBar },
    { id: 'view.board', label: 'View: Toggle Board', run: d.toggleBoard },
  ]
}

/**
 * Registers the app commands while App is mounted. Handlers go through a ref: App passes fresh
 * closures every render, and re-registering on each would re-render every registry reader.
 */
export function useAppCommands(deps: AppCommandDeps): void {
  const ref = useRef(deps)
  ref.current = deps
  const hasBrowser = deps.newBrowser !== undefined
  const hasDiff = deps.newDiff !== undefined
  const hasSticky = deps.newSticky !== undefined
  const list = useMemo(() => {
    const live = {} as Record<keyof AppCommandDeps, () => void>
    for (const k of Object.keys(ref.current) as (keyof AppCommandDeps)[]) live[k] = () => ref.current[k]?.()
    return appCommands({ ...live, newBrowser: hasBrowser ? live.newBrowser : undefined, newDiff: hasDiff ? live.newDiff : undefined, newSticky: hasSticky ? live.newSticky : undefined })
  }, [hasBrowser, hasDiff, hasSticky])
  useRegisterCommands(list)
}
