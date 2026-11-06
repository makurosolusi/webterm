// Notice for a board save the server refused (another window changed or deleted the board).
// Own root, same pattern as `osNotify.prompt.tsx`; one at a time, a new notice replaces the old.
import { createRoot } from 'react-dom/client'
import { VscodeNotification, type VscodeNotificationSeverity } from './components/vscode/vscodeNotification'

export const STALE_RELOADED_NOTICE = 'This workspace changed in another window. Reloaded the latest version.'
export const DELETED_NOTICE = 'This workspace was deleted in another window. Changes are no longer saved.'
export const staleNotSavedNotice = (name: string): string =>
  `Your last change to "${name}" was not saved: it changed in another window.`

let closeShown: (() => void) | null = null

export function showSaveNotice(title: string, severity: VscodeNotificationSeverity): void {
  closeShown?.()
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const close = () => {
    if (closeShown === close) closeShown = null
    root.unmount()
    host.remove()
  }
  closeShown = close
  root.render(<VscodeNotification id="webterm-workspace-save" severity={severity} title={title} onClose={close} />)
}
