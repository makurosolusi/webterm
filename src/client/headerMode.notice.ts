// One-time notice after a stored Full / Compact header value was carried over to Tabs: one line, no action
// that undoes anything (the old header no longer exists), never repeated. Any explicit choice retires it.
import { useEffect } from 'react'
import { showNotice } from './workspaceSave.notice'
import { headerNoticeDue, markHeaderNoticed } from './headerMode.store'

export const HEADER_NOTICE_CHANNEL = 'webterm-header-mode'

export const HEADER_NOTICE_TEXT = {
  title: 'The header is now the workspace tab row',
  message: 'The menu and search moved to the left rail. Hide the tab row any time in View > Header.',
} as const

/** Shows the notice once, the first time the board is up after the stored value was carried over. */
export function useHeaderModeNotice(hydrated: boolean): void {
  useEffect(() => {
    if (!hydrated || !headerNoticeDue()) return
    markHeaderNoticed()
    showNotice(HEADER_NOTICE_CHANNEL, { severity: 'info', title: HEADER_NOTICE_TEXT.title, message: HEADER_NOTICE_TEXT.message })
  }, [hydrated])
}
