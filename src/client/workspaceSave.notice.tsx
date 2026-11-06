// Workspace notices: a save the server refused or could not take, and a workspace action that
// failed. One root and one stack for all of them (keyed: a new notice replaces the one with the
// same key), same own-root pattern as `osNotify.prompt.tsx`.
import { createRoot, type Root } from 'react-dom/client'
import {
  VscodeNotification, VscodeNotificationStack, type VscodeNotificationAction, type VscodeNotificationSeverity,
} from './components/vscode/vscodeNotification'

export const STALE_RELOADED_NOTICE = 'This workspace changed in another window. Reloaded the latest version.'
export const DELETED_NOTICE = 'This workspace was deleted in another window. Changes are no longer saved.'
export const SAVE_RECOVERED_NOTICE = 'Workspace changes saved.'
export const staleNotSavedNotice = (name: string): string =>
  `Your last change to "${name}" was not saved: it changed in another window.`
export const saveFailedNotice = (name: string): string => `Could not save workspace "${name}". Your changes are kept and retried.`

/** Notice channels: one visible notice per key. */
export const SAVE_NOTICE_KEY = 'webterm-workspace-save'
export const ACTION_NOTICE_KEY = 'webterm-workspace-action'

export interface WorkspaceNotice {
  title: string
  severity: VscodeNotificationSeverity
  message?: string
  actions?: VscodeNotificationAction[]
}

const shown = new Map<string, WorkspaceNotice>()
let root: { root: Root; host: HTMLElement } | null = null

function render(): void {
  if (shown.size === 0) {
    root?.root.unmount()
    root?.host.remove()
    root = null
    return
  }
  if (!root) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = { root: createRoot(host), host }
  }
  root.root.render(
    <VscodeNotificationStack>
      {[...shown].map(([key, n]) => (
        <VscodeNotification key={key} id={key} severity={n.severity} title={n.title} message={n.message}
          actions={n.actions} onClose={() => closeNotice(key)} />
      ))}
    </VscodeNotificationStack>,
  )
}

/** Show (or replace) the notice on channel `key`. Warning/error stay until closed. */
export function showNotice(key: string, notice: WorkspaceNotice): void {
  shown.set(key, notice)
  render()
}

export function closeNotice(key: string): void {
  if (shown.delete(key)) render()
}

export function showSaveNotice(title: string, severity: VscodeNotificationSeverity): void {
  showNotice(SAVE_NOTICE_KEY, { title, severity })
}
