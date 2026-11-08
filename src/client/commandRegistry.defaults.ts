// webterm's built-in commands. Labels and default keys follow VS Code where a counterpart exists
// (Go to File ⌘P, Find in Files ⇧⌘F, Open Settings ⌘,, New Terminal ⌃⇧`). `FIXED_COMMANDS` are
// shortcuts other surfaces own (Monaco, xterm, React Flow, cleanView, Output): they live here so
// the Keyboard Shortcuts overlay is generated from one list and conflicts are checked against them.
import { useMemo, useRef } from 'react'
import { registerCommands, useRegisterCommands, type Command } from './commandRegistry'

export const FIXED_COMMANDS: Command[] = [
  { id: 'editor.save', label: 'File: Save (editor node)', defaultKey: 'Mod+S', scope: 'editor', fixed: true },
  { id: 'editor.togglePreview', label: 'Markdown: Toggle Preview (hovered editor node)', defaultKey: 'Mod+M', scope: 'editor', fixed: true },
  { id: 'terminal.fontZoomIn', label: 'Terminal: Zoom In Font (needs "Zoom font via keyboard")', defaultKey: 'Mod+=', scope: 'terminal', fixed: true },
  { id: 'terminal.fontZoomOut', label: 'Terminal: Zoom Out Font', defaultKey: 'Mod+-', scope: 'terminal', fixed: true },
  { id: 'terminal.fontZoomReset', label: 'Terminal: Reset Font Size', defaultKey: 'Mod+0', scope: 'terminal', fixed: true },
  { id: 'terminal.newline', label: 'Terminal: Insert Newline Without Sending', defaultKey: 'Shift+Enter', scope: 'terminal', fixed: true },
  { id: 'browser.focusUrl', label: 'Browser: Focus Address Bar (focused browser node)', defaultKey: 'Mod+L', scope: 'browser', fixed: true },
  { id: 'browser.reload', label: 'Browser: Reload', defaultKey: 'Mod+R', scope: 'browser', fixed: true },
  { id: 'browser.hardReload', label: 'Browser: Hard Reload', defaultKey: 'Mod+Shift+R', scope: 'browser', fixed: true },
  { id: 'browser.back', label: 'Browser: Back (Alt+Left on Windows/Linux)', defaultKey: 'Mod+[', scope: 'browser', fixed: true },
  { id: 'browser.forward', label: 'Browser: Forward (Alt+Right on Windows/Linux)', defaultKey: 'Mod+]', scope: 'browser', fixed: true },
  { id: 'browser.zoomIn', label: 'Browser: Zoom In Page', defaultKey: 'Mod+=', scope: 'browser', fixed: true },
  { id: 'browser.zoomOut', label: 'Browser: Zoom Out Page', defaultKey: 'Mod+-', scope: 'browser', fixed: true },
  { id: 'browser.zoomReset', label: 'Browser: Reset Page Zoom', defaultKey: 'Mod+0', scope: 'browser', fixed: true },
  { id: 'browser.zoomPinch', label: 'Browser: Zoom Page', gesture: 'Ctrl+scroll or pinch', scope: 'browser', fixed: true },
  { id: 'browser.stop', label: 'Browser: Stop Loading (while loading)', defaultKey: 'Escape', scope: 'browser', fixed: true },
  { id: 'browser.toggleConsole', label: 'Browser: Toggle Console (focused browser node)', defaultKey: 'Mod+Alt+J', scope: 'browser', fixed: true },
  { id: 'files.quickOpen', label: 'Files: Go to File in This Folder (focused Files node)', defaultKey: 'Mod+P', scope: 'files', fixed: true },
  { id: 'output.toggle.key', label: 'View: Toggle Output', defaultKey: 'Mod+Shift+U', fixed: true, hidden: true },
  { id: 'view.cleanView.key', label: 'View: Toggle Clean View', defaultKey: 'Mod+.', fixed: true, hidden: true },
  { id: 'canvas.deleteSelection', label: 'Canvas: Delete Selected Nodes or Edges', defaultKey: 'Backspace', scope: 'canvas', fixed: true },
  { id: 'canvas.deleteSelection.alt', label: 'Canvas: Delete Selected Nodes or Edges', defaultKey: 'Delete', scope: 'canvas', fixed: true },
  { id: 'canvas.unlinkEdge', label: 'Canvas: Remove Context Link', gesture: 'Double-click edge', scope: 'canvas', fixed: true },
  { id: 'workbench.closeOverlay', label: 'Close Overlay, Settings, or Filter', defaultKey: 'Escape', scope: 'canvas', fixed: true },
]

// Static facts, not tied to App's lifetime: registered once on import so the overlay lists them
// even where App is not mounted (and an App unmount cannot drop them).
registerCommands(FIXED_COMMANDS)

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
    { id: 'terminal.new', label: 'Terminal: New Terminal', defaultKey: 'Ctrl+Shift+`', run: d.newTerminal },
    { id: 'files.new', label: 'Explorer: New Files Node', run: d.newFiles },
    ...(d.newBrowser ? [{ id: 'browser.new', label: 'Browser: New Browser Node', run: d.newBrowser }] : []),
    ...(d.newDiff ? [{ id: 'diff.new', label: 'Diff: New Diff Node (working changes)', run: d.newDiff }] : []),
    { id: 'view.fit', label: 'View: Fit Canvas', run: d.fitView },
    { id: 'view.toggleMaximizeNode', label: 'View: Toggle Maximize Node', run: d.toggleMaximizeNode },
    { id: 'view.sessions', label: 'View: Toggle Sessions', run: d.toggleSessions },
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
  const list = useMemo(() => {
    const live = {} as Record<keyof AppCommandDeps, () => void>
    for (const k of Object.keys(ref.current) as (keyof AppCommandDeps)[]) live[k] = () => ref.current[k]?.()
    return appCommands({ ...live, newBrowser: hasBrowser ? live.newBrowser : undefined, newDiff: hasDiff ? live.newDiff : undefined })
  }, [hasBrowser, hasDiff])
  useRegisterCommands(list)
}
