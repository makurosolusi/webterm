// Title-bar account button: a menu anchored to it, like VS Code's Accounts menu (GitHub, Slack and
// Google do the same): who is signed in, Account settings, Settings, Keyboard Shortcuts, then Sign out.
// Without an account (`onOpenAccount` absent) the header and Account settings are left out.
import { DropdownMenu } from 'radix-ui'
import { useEffect, useState } from 'react'
import { IconTooltip } from '@/components/ui/icon-button'
import { portalContainer } from '@/components/vscode/portalContainer'
import { ACCOUNT_TEXT } from './accountLabels'
import { fetchMe, type AuthUser } from './transportToken'
import { useSignOut } from './useSignOut'
import './agentChat/agentChatToolbar.css'

export const ACCOUNT_MENU_TEXT = {
  button: 'Account',
  tooltip: 'Account: who is signed in, settings and sign out',
  loading: 'Loading account…',
  signedInAs: (username: string) => `Signed in as ${username}`,
  accountSettings: 'Account settings',
  settings: 'Settings',
  shortcuts: 'Keyboard Shortcuts',
  signOut: 'Sign out',
  signingOut: 'Signing out…',
} as const

export interface AccountMenuProps {
  /** Settings › Account; absent when no account system is active (token sign-in only). */
  onOpenAccount?: () => void
  onOpenSettings?: () => void
  onOpenHelp?: () => void
  /** After a successful Sign out; tests replace it. Default reloads to the sign-in page. */
  reload?: () => void
}

type Who = { state: 'loading' } | { state: 'ok'; user: AuthUser | null } | { state: 'error'; text: string }

/** The account button and its menu. */
export function AccountMenu({ onOpenAccount, onOpenSettings, onOpenHelp, reload }: AccountMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [who, setWho] = useState<Who>({ state: 'loading' })
  const out = useSignOut(reload)
  const hasAccount = !!onOpenAccount

  // Asked on every open, so a username changed in Settings shows the next time the menu opens.
  useEffect(() => {
    if (!open || !hasAccount) return
    const ac = new AbortController()
    setWho({ state: 'loading' })
    fetchMe(ac.signal).then(
      (m) => setWho({ state: 'ok', user: m.user }),
      (e: unknown) => { if (!ac.signal.aborted) setWho({ state: 'error', text: ACCOUNT_TEXT.loadFailed(e instanceof Error ? e.message : String(e)) }) },
    )
    return () => ac.abort()
  }, [open, hasAccount])

  return (
    <DropdownMenu.Root modal={false} open={open} onOpenChange={setOpen}>
      <IconTooltip label={ACCOUNT_MENU_TEXT.tooltip}>
        <DropdownMenu.Trigger asChild>
          <button type="button" className="titlebar__action" aria-label={ACCOUNT_MENU_TEXT.button}>
            <span className="codicon codicon-account" aria-hidden />
          </button>
        </DropdownMenu.Trigger>
      </IconTooltip>
      <DropdownMenu.Portal container={portalContainer()}>
        <DropdownMenu.Content className="act-menu" side="bottom" align="end" sideOffset={4}>
          {hasAccount && (
            <>
              <WhoLabel who={who} />
              <DropdownMenu.Item className="act-menu__item" onSelect={onOpenAccount}>{ACCOUNT_MENU_TEXT.accountSettings}</DropdownMenu.Item>
            </>
          )}
          {onOpenSettings && <DropdownMenu.Item className="act-menu__item" onSelect={onOpenSettings}>{ACCOUNT_MENU_TEXT.settings}</DropdownMenu.Item>}
          {onOpenHelp && <DropdownMenu.Item className="act-menu__item" onSelect={onOpenHelp}>{ACCOUNT_MENU_TEXT.shortcuts}</DropdownMenu.Item>}
          <DropdownMenu.Separator className="act-menu__separator" />
          <DropdownMenu.Item
            className="act-menu__item"
            disabled={out.busy}
            aria-busy={out.busy}
            // Stays open so the busy line and a refusal are seen; success reloads the page.
            onSelect={(e) => { e.preventDefault(); out.signOut() }}
          >
            {out.busy ? ACCOUNT_MENU_TEXT.signingOut : ACCOUNT_MENU_TEXT.signOut}
          </DropdownMenu.Item>
          {out.error && <p role="alert" className="act-menu__note act-menu__note--error">{out.error}</p>}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function WhoLabel({ who }: { who: Who }): React.JSX.Element {
  const text = who.state === 'loading' ? ACCOUNT_MENU_TEXT.loading
    : who.state === 'error' ? who.text
    : who.user ? ACCOUNT_MENU_TEXT.signedInAs(who.user.username) : ACCOUNT_TEXT.noAccount
  return (
    <>
      <DropdownMenu.Label className={`act-menu__note${who.state === 'error' ? ' act-menu__note--error' : ''}`} role={who.state === 'loading' ? 'status' : undefined}>
        {text}
      </DropdownMenu.Label>
      <DropdownMenu.Separator className="act-menu__separator" />
    </>
  )
}
