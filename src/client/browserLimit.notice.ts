// The "too many active browsers" toast with a way out: "Raise limit to N" (one step, up to the range maximum, applied at
// once) and "Settings" (Settings > Browser > Active browsers limit). `retry` re-runs the open that was refused.
import { MAX_LIVE_RANGE } from '../shared/browser.contract'
import { getBrowserStatus, raiseBrowserLimit } from './browser.api'
import { resetBrowserStatusCache } from './browser.feature'
import { appNavigate } from './appRoute'
import type { VscodeNotificationAction, VscodeNotificationSeverity } from './components/vscode/vscodeNotification'
import { showNotice } from './workspaceSave.notice'

export const LIMIT_NOTICE_TEXT = {
  raise: (to: number): string => `Raise limit to ${to}`,
  settings: 'Settings',
  tryAgain: 'Try again',
  raised: (to: number): string => `Active browsers limit is now ${to}.`,
  raiseFailed: 'Could not raise the limit. Change it in Settings > Browser.',
  atMax: (max: number): string => `The maximum is ${max}; see Settings.`,
} as const

const openSettings = (): void => { appNavigate()?.openSettings('browser', 'browser-limit') }

/**
 * Show `title` on channel `key` with the limit actions. `max` = the current limit when the caller already knows it;
 * otherwise it is read from the server first. At the range maximum there is no raise button and the text points at Settings.
 */
export async function showLimitNotice(key: string, severity: VscodeNotificationSeverity, title: string, o: { max?: number; retry?: () => void } = {}): Promise<void> {
  const max = o.max ?? (await getBrowserStatus().then((s) => s.maxLive, () => 0))
  const actions: VscodeNotificationAction[] = []
  if (max > 0 && max < MAX_LIVE_RANGE.max) {
    actions.push({
      label: LIMIT_NOTICE_TEXT.raise(max + 1),
      onClick: () => {
        raiseBrowserLimit(max).then((to) => {
          resetBrowserStatusCache()
          const retry = o.retry
          showNotice(key, { severity: 'info', title: LIMIT_NOTICE_TEXT.raised(to ?? max), actions: retry ? [{ label: LIMIT_NOTICE_TEXT.tryAgain, onClick: retry }] : [] })
        }, () => showNotice(key, { severity: 'error', title: LIMIT_NOTICE_TEXT.raiseFailed, actions: [{ label: LIMIT_NOTICE_TEXT.settings, onClick: openSettings }] }))
      },
    })
  }
  actions.push({ label: LIMIT_NOTICE_TEXT.settings, onClick: openSettings })
  showNotice(key, { severity, title: max >= MAX_LIVE_RANGE.max ? `${title} ${LIMIT_NOTICE_TEXT.atMax(max)}` : title, actions })
}
