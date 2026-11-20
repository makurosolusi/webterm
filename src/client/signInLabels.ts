// Every sentence of the sign-in and first-run setup screens (SignInScreen, SignInForms, mobile).

/** Must match PASSWORD_MIN in src/server/uiUser.ts (NIST 800-63B minimum, counted in characters). */
export const PASSWORD_MIN = 12

/** Must match USERNAME_RE in src/server/uiUser.ts; the server stays the authority. */
export const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,32}$/

/** Characters as the server counts them (code points, not UTF-16 units). */
export const charCount = (s: string): number => [...s].length

export const SIGN_IN_TEXT = {
  loading: 'Checking sign-in…',
  title: 'Sign in to webterm',
  setupTitle: 'Create your account',
  setupIntro: 'This account protects your webterm. You only do this once.',
  capsLock: 'Caps Lock is on.',
  unreachable: "Couldn't reach the server. Check your connection and try again.",
  accountExists: 'An account already exists. Sign in instead.',
  intro: 'Sign in with your webterm account.',
  localNote: 'Your account stays on this server. Nothing is sent anywhere else.',
  or: 'or',
  open: 'Open signed-in window',
  opening: 'A signed-in webterm window is opening on the computer running webterm. This tab follows by itself once you are signed in.',
  rateLimited: (s: number) => `A window was just opened. You can ask again in ${s} s.`,
  usernameLabel: 'Username',
  passwordLabel: 'Password',
  confirmLabel: 'Confirm password',
  usernameHint: '3 to 32 letters, digits, dots, dashes or underscores.',
  show: (field: string) => `Show ${field}`,
  hide: (field: string) => `Hide ${field}`,
  requirements: 'Password requirements',
  checkLength: `At least ${PASSWORD_MIN} characters`,
  checkMatch: 'Both passwords match',
  checkMet: '(done)',
  checkPending: '(not yet)',
  needUsername: 'Enter a username.',
  needPassword: 'Enter your password.',
  needConfirm: 'Type the password again.',
  matches: 'Passwords match',
  lengthHint: (n: number) => (n >= PASSWORD_MIN ? `${n} characters. Long enough.` : `At least ${PASSWORD_MIN} characters (${n} so far).`),
  signIn: 'Sign in',
  create: 'Create account',
  working: 'Working…',
  signingIn: 'Signing in…',
  creating: 'Creating account…',
  wrongCredentials: 'Wrong username or password.',
  tooMany: (s: number) => `Too many attempts. Try again in ${s} s.`,
  mismatch: 'The passwords do not match.',
  weakPassword: `Use at least ${PASSWORD_MIN} characters.`,
  invalidUsername: 'Usernames are 3 to 32 characters: letters, digits, dot, dash or underscore.',
  signedIn: 'Signed in. Loading webterm…',
  offline: 'Cannot reach the server. Still checking every 2 s.',
  stillRefused: 'This browser is signed in, but the server still refused to load the workspaces. Reload to try again.',
  retry: 'Retry',
  failed: (what: string, cause: string) => `${what} failed: ${cause}`,
  mobileSetup: 'No account exists yet. Create the account on the computer running webterm first, then sign in here.',
} as const

/** Sentence for a sign-in or setup answer that is not a success; `retryS` is the 429 countdown. */
export function authErrorText(status: number, error: string | null, retryS: number): string {
  if (status === 429) return SIGN_IN_TEXT.tooMany(Math.max(1, retryS))
  switch (error) {
    case 'invalid_credentials': return SIGN_IN_TEXT.wrongCredentials
    case 'weak_password': return SIGN_IN_TEXT.weakPassword
    case 'invalid_username': return SIGN_IN_TEXT.invalidUsername
    case 'already_setup': return SIGN_IN_TEXT.accountExists
    default:
      if (status === 401) return SIGN_IN_TEXT.wrongCredentials
      return status >= 500 ? SIGN_IN_TEXT.unreachable : SIGN_IN_TEXT.failed('Signing in', `HTTP ${status}`)
  }
}
