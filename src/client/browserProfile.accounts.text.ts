// Text and pure helpers for "who is signed in" on a browser profile (chip menu + Settings > Browser). English only.
import { ACCOUNT_CHECK_TTL_MS, providerOf, signedInAccounts } from '../shared/browser.accounts'
import type { ProfileAccount } from '../shared/browser.accounts'

const MIN = 60_000

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function agoText(now: number, at: number): string {
  const d = Math.max(0, now - at)
  if (d < MIN) return 'just now'
  if (d < 60 * MIN) return `${Math.floor(d / MIN)} min ago`
  if (d < 24 * 60 * MIN) return `${Math.floor(d / (60 * MIN))} h ago`
  return `${Math.floor(d / (24 * 60 * MIN))} d ago`
}

export const ACCOUNT_TEXT = {
  header: 'Accounts in this profile',
  settingsTitle: 'Accounts',
  signedIn: 'Signed in',
  signedOut: 'Signed out',
  expired: 'Session expired',
  unknown: 'Unknown',
  notSignedIn: 'Not signed in',
  none: 'No accounts detected',
  noneHint: 'Sign in to Google or GitHub in this profile and it shows up here. Only a name and a masked email are kept.',
  checking: 'Checking accounts…',
  refresh: 'Refresh accounts',
  refreshing: 'Checking…',
  failed: 'Accounts could not be checked.',
  retry: 'Retry',
  unknownHint: 'The provider did not answer in a way webterm could read. It will try again later.',
  refreshed: (n: number): string => (n === 0 ? 'No accounts detected' : `${n} signed in`),
  refreshFailed: (why: string): string => `Could not check accounts: ${why}`,
  checked: (now: number, at: number): string => `checked ${agoText(now, at)}`,
} as const

export const stateText = (a: Pick<ProfileAccount, 'state'>): string =>
  a.state === 'signed_in' ? ACCOUNT_TEXT.signedIn : a.state === 'expired' ? ACCOUNT_TEXT.expired : a.state === 'signed_out' ? ACCOUNT_TEXT.signedOut : ACCOUNT_TEXT.unknown

export const providerLabel = (a: Pick<ProfileAccount, 'provider'>): string => providerOf(a.provider)?.label ?? a.provider

/** "Google · Bip" for a signed-in account, "Google · Session expired" otherwise. */
export const accountTitle = (a: ProfileAccount): string => `${providerLabel(a)} · ${a.state === 'signed_in' ? (a.displayName ?? ACCOUNT_TEXT.signedIn) : stateText(a)}`

/** Full tooltip: provider, name, masked email, state, when it was checked. */
export const accountDetail = (a: ProfileAccount, now: number): string =>
  [providerLabel(a), a.displayName, a.emailMasked, stateText(a), ACCOUNT_TEXT.checked(now, a.checkedAt)].filter(Boolean).join(' · ')

/** What to list: everything that is not plain "signed out" (kept out of the way); empty when nobody is signed in or expired. */
export const visibleAccounts = (all: readonly ProfileAccount[]): ProfileAccount[] => all.filter((a) => a.state !== 'signed_out')

/** One line for tooltips: "Google: Bip (b***@gmail.com)" or "Not signed in" / "No accounts detected". */
export function accountsSummary(all: readonly ProfileAccount[]): string {
  if (all.length === 0) return ACCOUNT_TEXT.none
  const shown = visibleAccounts(all)
  if (shown.length === 0) return ACCOUNT_TEXT.notSignedIn
  return shown.map((a) => (a.state === 'signed_in' ? `${providerLabel(a)}: ${[a.displayName, a.emailMasked && `(${a.emailMasked})`].filter(Boolean).join(' ') || ACCOUNT_TEXT.signedIn}` : `${providerLabel(a)}: ${stateText(a)}`)).join(', ')
}

/** Nothing known yet, or the oldest answer is past the check TTL. */
export const accountsStale = (all: readonly ProfileAccount[], now: number): boolean =>
  all.length === 0 || all.some((a) => now - a.checkedAt > ACCOUNT_CHECK_TTL_MS)

export const hasSignedIn = (all: readonly ProfileAccount[] | undefined): boolean => signedInAccounts(all).length > 0
