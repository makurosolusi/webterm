// Settings > Browser: the accounts a profile is signed in to, under its row. A compact line per account (provider, name,
// masked email, state, when it was checked), a Refresh button with action feedback, and the empty / not signed in states.
// A profile with no running browser cannot be checked (nothing is launched for a check): no button, one line says why.
import { ActionButton, ActionResult, errorCause, useAction } from '@/components/ui/action'
import { signedInAccounts } from '../shared/browser.accounts'
import type { BrowserProfile } from '../shared/browser.profile'
import { ACCOUNT_TEXT as T, accountDetail, accountTitle, visibleAccounts } from './browserProfile.accounts.text'
import { useProfileAccounts } from './browserProfile.accounts.use'

const LIVE_ONLY = 'Accounts are checked while a browser runs on this profile.'

export default function BrowserProfileAccounts({ profile }: { profile: BrowserProfile }): React.JSX.Element {
  const view = useProfileAccounts(profile)
  const refresh = useAction(() => view.refresh(false), {
    label: T.refresh,
    success: (r) => T.refreshed(signedInAccounts(r).length),
    failure: (e) => T.refreshFailed(errorCause(e)),
  })
  const now = Date.now()
  const shown = visibleAccounts(view.accounts)
  const empty = view.accounts.length === 0 ? T.none : shown.length === 0 ? T.notSignedIn : null
  return (
    <div className="flex flex-col gap-1 pl-[18px]" data-profile-accounts={profile.id}>
      <ul role="list" aria-label={`${T.settingsTitle}: ${profile.name}`} className="m-0 flex list-none flex-col gap-0.5 p-0 text-xs">
        {empty && <li className="text-(--vscode-descriptionForeground)" data-account-empty>{empty}{profile.live ? '' : `. ${LIVE_ONLY}`}</li>}
        {shown.map((a) => (
          <li key={a.provider} data-account={a.provider} data-state={a.state} title={accountDetail(a, now)} className="flex flex-wrap gap-x-1">
            <span className={a.state === 'signed_in' ? 'text-(--vscode-charts-green)' : a.state === 'expired' ? 'text-(--vscode-charts-yellow)' : 'text-(--vscode-descriptionForeground)'}>{accountTitle(a)}</span>
            {a.state === 'signed_in' && a.emailMasked && <span className="text-(--vscode-descriptionForeground)">{a.emailMasked}</span>}
            <span className="text-(--vscode-descriptionForeground)">· {T.checked(now, a.checkedAt)}</span>
          </li>
        ))}
      </ul>
      {profile.live && (
        <div className="flex flex-wrap items-center gap-2">
          <ActionButton size="bui" variant="ghost" action={refresh} busyLabel={T.refreshing}>
            <span className="codicon codicon-refresh" aria-hidden="true" />{T.refresh}
          </ActionButton>
          <ActionResult action={refresh} stamp="checked" />
        </div>
      )}
    </div>
  )
}
