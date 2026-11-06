// What the user sees of the save state (ui-210-4): a sticky "Could not save … Retry" error notice
// while a save is failing, a short "saved" notice once it recovers, and a status bar entry that
// stays until then, VS Code "Failed to save '<file>'" + dirty indicator style.
import { useEffect, useMemo, useRef } from 'react'
import { codicon } from './dockCodicon'
import { SAVE_NOTICE_KEY, SAVE_RECOVERED_NOTICE, closeNotice, saveFailedNotice, showNotice } from './workspaceSave.notice'
import type { SaveState } from './workspaceSaveQueue'
import type { VscodeStatusItem } from './components/vscode/vscodeStatusBar'

export const SAVE_RETRY_LABEL = 'Retry'
export const UNSAVED_STATUS_LABEL = 'Unsaved changes'

export function useSaveStateSurface(state: SaveState, nameOf: (id: string) => string, retry: () => void): VscodeStatusItem[] {
  const failedBefore = useRef(false)
  const failed = state.kind === 'error'
  const failedId = failed ? state.workspaceId : null
  const message = failed ? state.message : null

  useEffect(() => {
    if (failedId !== null) {
      failedBefore.current = true
      showNotice(SAVE_NOTICE_KEY, {
        title: saveFailedNotice(nameOf(failedId)), message: message ?? undefined, severity: 'error',
        actions: [{ label: SAVE_RETRY_LABEL, onClick: retry }],
      })
      return
    }
    if (!failedBefore.current || state.kind === 'saving') return
    failedBefore.current = false
    if (state.kind === 'idle') showNotice(SAVE_NOTICE_KEY, { title: SAVE_RECOVERED_NOTICE, severity: 'info' })
  }, [failedId, message, state.kind, nameOf, retry])

  // A notice left behind by an unmounted App would outlive it (tests mount many Apps).
  useEffect(() => () => closeNotice(SAVE_NOTICE_KEY), [])

  return useMemo<VscodeStatusItem[]>(() => (failedId === null ? [] : [{
    id: 'workspace-save', label: UNSAVED_STATUS_LABEL, icon: codicon('warning'), tone: 'error',
    tooltip: `${saveFailedNotice(nameOf(failedId))} Click to retry now.`, ariaLabel: `${UNSAVED_STATUS_LABEL}: retry saving`,
    onClick: retry,
  }]), [failedId, nameOf, retry])
}
