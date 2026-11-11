import { useDisconnected } from './useConnection'

/** Overlay text; exported for tests. */
export const TERMINAL_OFFLINE_TEXT = 'Disconnected — input paused'

/**
 * Slim overlay over a terminal while the shared socket is down (pty-207-5). VS Code marks a terminal
 * whose backend went away instead of letting keystrokes vanish silently: ws.ts drops input while
 * offline, it is never replayed later into whatever the shell runs by then. The countdown and
 * "Retry now" live once in the app-wide ConnectionStatus, not in every terminal.
 */
export function TerminalOffline() {
  if (!useDisconnected()) return null
  return (
    <div
      role="status"
      className="nodrag pointer-events-none absolute top-2 right-2 z-10 flex items-center gap-1 rounded px-2 py-0.5 text-xs bg-(--vscode-editorWidget-background) text-(--vscode-foreground) border border-(--vscode-editorWidget-border)"
    >
      <span className="codicon codicon-debug-disconnect text-amber-600" aria-hidden />
      <span>{TERMINAL_OFFLINE_TEXT}</span>
    </div>
  )
}
