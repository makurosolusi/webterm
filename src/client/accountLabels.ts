// Every sentence of Settings › Account (AccountSection, AccountSessions), plus the small formatters
// it shows: "Chrome on macOS" from a User-Agent and "5 min ago" from a timestamp.
import { PASSWORD_MIN } from './signInLabels'

export const ACCOUNT_TEXT = {
  loading: 'Loading your account…',
  loadFailed: (cause: string) => `Could not load your account: ${cause}`,
  retry: 'Retry',
  noAccount: 'This browser is not signed in to an account.',
  signedInAs: 'Signed in as',
  usernameTitle: 'Change username',
  newUsername: 'New username',
  password: 'Password',
  saveUsername: 'Change username',
  usernameChanged: 'Username changed.',
  passwordTitle: 'Change password',
  currentPassword: 'Current password',
  newPassword: 'New password',
  confirmPassword: 'Confirm new password',
  savePassword: 'Change password',
  passwordChanged: 'Password changed. Other sessions were signed out.',
  working: 'Working…',
  sessionsTitle: 'Sessions',
  sessionsIntro: 'Browsers signed in to your account. Sign out any you do not recognise.',
  sessionsLoading: 'Loading sessions…',
  sessionsEmpty: 'No sessions.',
  sessionsFailed: (cause: string) => `Could not load the sessions: ${cause}`,
  thisDevice: 'This device',
  lastActive: (when: string) => `Last active ${when}`,
  signOutRow: 'Sign out',
  signOutRowLabel: (browser: string) => `Sign out ${browser}`,
  signOutOthers: 'Sign out all other sessions',
  signedOutOthers: (n: number) => (n === 1 ? 'Signed out 1 other session.' : `Signed out ${n} other sessions.`),
  rowGone: 'That session had already ended.',
  signOutTitle: 'Sign out',
  signOutIntro: 'End the session in this browser. You will need your password to come back.',
  signOut: 'Sign out',
  wrongPassword: 'Wrong password.',
  wrongCurrent: 'The current password is wrong.',
  usernameTaken: 'That username is taken.',
  invalidUsername: 'Usernames are 3 to 32 characters: letters, digits, dot, dash or underscore.',
  weakPassword: `Use at least ${PASSWORD_MIN} characters.`,
  mismatch: 'The new passwords do not match.',
  tooMany: (s: number) => `Too many attempts. Try again in ${s} s.`,
  notSignedIn: 'Your session ended. Reload the page to sign in again.',
  failed: (what: string, cause: string) => `${what} failed: ${cause}`,
} as const

/** Sentence for a refused Account change; `wrong` is the 401 sentence of that form. */
export function accountErrorText(wrong: string): (status: number, error: string | null, retryS: number) => string {
  return (status, error, retryS) => {
    if (status === 429) return ACCOUNT_TEXT.tooMany(Math.max(1, retryS))
    if (error === 'not_signed_in') return ACCOUNT_TEXT.notSignedIn
    if (status === 401) return wrong
    if (error === 'username_taken') return ACCOUNT_TEXT.usernameTaken
    if (error === 'invalid_username') return ACCOUNT_TEXT.invalidUsername
    if (error === 'weak_password') return ACCOUNT_TEXT.weakPassword
    return ACCOUNT_TEXT.failed('The change', `HTTP ${status}`)
  }
}

/** "Firefox on Linux" from a User-Agent; "Unknown browser" when absent. Order matters: Edge and Opera say Chrome too. */
export function browserLabel(ua: string | null): string {
  if (!ua) return 'Unknown browser'
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : null
  return os ? `${browser} on ${os}` : browser
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [['day', 86_400_000], ['hour', 3_600_000], ['minute', 60_000]]

/** "just now", "5 minutes ago", "2 days ago" (Intl.RelativeTimeFormat). */
export function relativeTime(at: number, now: number): string {
  const ago = now - at
  const fmt = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  for (const [unit, ms] of UNITS) if (ago >= ms) return fmt.format(-Math.floor(ago / ms), unit)
  return 'just now'
}
