// "Accounts in this profile" section of the chip menu: one row per account (provider, name, masked email, state),
// "Not signed in" / "No accounts detected" / "Checking…" / failure rows, and "Refresh accounts". Rows are plain menu
// rows; the hover text carries the full detail and when it was checked.
import type { ProfileAccount } from '../shared/browser.accounts'
import type { VscodeMenuItem } from './components/vscode/vscodeMenu'
import { ACCOUNT_TEXT as T, accountDetail, accountTitle, stateText, visibleAccounts } from './browserProfile.accounts.text'

const PROVIDER_ICON: Record<string, string> = { google: 'codicon-globe', github: 'codicon-source-control' }

const icon = (name: string, tone?: 'ok' | 'warn'): React.JSX.Element => (
  <span
    className={`codicon ${name} ${tone === 'ok' ? 'text-(--vscode-charts-green)' : tone === 'warn' ? 'text-(--vscode-charts-yellow)' : 'text-(--vscode-descriptionForeground)'}`}
    aria-hidden="true"
  />
)

export interface AccountMenuInput {
  accounts: readonly ProfileAccount[]
  loading: boolean
  failed: boolean
  now: number
  onRefresh(): void
}

export function accountMenuItems(i: AccountMenuInput): VscodeMenuItem[] {
  const shown = visibleAccounts(i.accounts)
  let rows: VscodeMenuItem[]
  if (i.accounts.length === 0) {
    rows = i.loading
      ? [{ type: 'item', id: 'accounts-checking', label: T.checking, disabled: true, icon: icon('codicon-loading codicon-modifier-spin') }]
      : [{ type: 'item', id: 'accounts-none', label: T.none, disabled: true, title: T.noneHint, icon: icon('codicon-account') }]
  } else if (shown.length === 0) {
    rows = [{ type: 'item', id: 'accounts-signed-out', label: T.notSignedIn, disabled: true, title: i.accounts.map((a) => accountDetail(a, i.now)).join('\n'), icon: icon('codicon-account') }]
  } else {
    rows = shown.map((a) => ({
      type: 'item' as const, id: `account-${a.provider}`, label: accountTitle(a), keybinding: a.state === 'signed_in' ? a.emailMasked : undefined,
      disabled: true, title: a.state === 'unknown' ? `${accountDetail(a, i.now)}\n${T.unknownHint}` : accountDetail(a, i.now),
      icon: icon(PROVIDER_ICON[a.provider] ?? 'codicon-account', a.state === 'signed_in' ? 'ok' : a.state === 'expired' ? 'warn' : undefined),
    }))
  }
  if (i.failed) rows.push({ type: 'item', id: 'accounts-failed', label: `${T.failed} ${T.retry}`, onSelect: i.onRefresh })
  return [
    { type: 'separator' }, { type: 'header', label: T.header }, ...rows,
    { type: 'item', id: 'accounts-refresh', label: i.loading ? T.refreshing : T.refresh, disabled: i.loading, icon: icon(i.loading ? 'codicon-loading codicon-modifier-spin' : 'codicon-refresh'), onSelect: i.onRefresh },
  ]
}

export { stateText }
