// One-time notice after the default header became Compact: one line, one action, never repeated.
// Shown only when it is true and useful: nobody chose a mode on this device, the board is up and the
// header is actually drawn Compact. Any explicit choice (including the action) retires it.
import { useEffect } from 'react'
import { closeNotice, showNotice } from './workspaceSave.notice'
import { headerNoticeDue, markHeaderNoticed, setHeaderMode, type HeaderMode } from './headerMode.store'

export const HEADER_NOTICE_CHANNEL = 'webterm-header-mode'

export const HEADER_NOTICE_TEXT = {
  title: 'Header is now compact',
  message: 'Workspaces and the menu stay in the header row. Change it any time in View > Header.',
  restore: 'Restore full header',
} as const

/** Shows the notice the first time the effective mode is Compact and nothing was ever chosen. */
export function useHeaderModeNotice(effective: HeaderMode): void {
  useEffect(() => {
    if (effective !== 'compact' || !headerNoticeDue()) return
    markHeaderNoticed()
    showNotice(HEADER_NOTICE_CHANNEL, {
      severity: 'info',
      title: HEADER_NOTICE_TEXT.title,
      message: HEADER_NOTICE_TEXT.message,
      actions: [{ label: HEADER_NOTICE_TEXT.restore, onClick: () => { setHeaderMode('full'); closeNotice(HEADER_NOTICE_CHANNEL) } }],
    })
  }, [effective])
}
