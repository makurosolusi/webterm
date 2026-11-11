// Every sentence of the sign-in and first-run setup screens (SignInScreen, SignInForms, mobile).

/** Must match PASSWORD_MIN in src/server/uiUser.ts (NIST 800-63B minimum, counted in characters). */
export const PASSWORD_MIN = 12

/** Characters as the server counts them (code points, not UTF-16 units). */
export const charCount = (s: string): number => [...s].length

export const SIGN_IN_TEXT = {
  loading: 'Checking sign-in…',
  title: 'Sign in to webterm',
  setupTitle: 'Create your webterm account',
  intro: 'Sign in with your webterm account.',
  setupIntroProof: 'This is the first time webterm runs here. Create the account you will sign in with.',
  setupIntroNoProof: 'No account exists yet. Create it from the computer running webterm, so nobody else can claim this install.',
  open: 'Open signed-in window',
  openSetup: 'Open setup window on this computer',
  opening: 'A signed-in webterm window is opening on the computer running webterm. This tab follows by itself once you are signed in.',
  rateLimited: (s: number) => `A window was just opened. You can ask again in ${s} s.`,
  otherDevice: 'Setting up from another device?',
  setupCodeLabel: 'Setup code',
  setupCodeHint: 'Find it in secrets/SETUP_CODE inside the webterm data directory (~/.webterm-server unless WEBTERM_DATA_DIR is set) on the computer running webterm.',
  usernameLabel: 'Username',
  passwordLabel: 'Password',
  confirmLabel: 'Confirm password',
  lengthHint: (n: number) => (n >= PASSWORD_MIN ? `${n} characters. Long enough.` : `At least ${PASSWORD_MIN} characters (${n} so far).`),
  signIn: 'Sign in',
  create: 'Create account',
  working: 'Working…',
  wrongCredentials: 'Wrong username or password.',
  tooMany: (s: number) => `Too many attempts. Try again in ${s} s.`,
  mismatch: 'The passwords do not match.',
  weakPassword: `Use at least ${PASSWORD_MIN} characters.`,
  invalidUsername: 'Usernames are 3 to 32 characters: letters, digits, dot, dash or underscore.',
  proofRequired: 'This browser could not prove it is on the computer running webterm. Use "Open setup window on this computer" there, or enter the setup code from that computer.',
  alreadySetup: 'An account already exists on this webterm. Sign in with it.',
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
    case 'setup_proof_required': return SIGN_IN_TEXT.proofRequired
    case 'already_setup': return SIGN_IN_TEXT.alreadySetup
    default: return status === 401 ? SIGN_IN_TEXT.wrongCredentials : SIGN_IN_TEXT.failed('Signing in', `HTTP ${status}`)
  }
}
