// One-time setup code for the first account: while no account exists, `<dataDir>/secrets/SETUP_CODE`
// (0600, via the same secret store as the root token) holds a random code that only someone who can
// read the data dir knows. Creating the owner account requires it, so a local process that can merely
// reach the port cannot claim a fresh install. The value is never returned for logging: callers get
// the file PATH to print.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { createFileSecretStore } from './envSecrets.store'
import { uiUsers, type UserStore } from './uiUser'

/** File name inside `<dataDir>/secrets`. */
export const SETUP_CODE_KEY = 'SETUP_CODE'
const SECRETS_SUBDIR = 'secrets'
/** 128 bits, hex: long enough that guessing is hopeless, still copyable by hand. */
const SETUP_CODE_BYTES = 16
const SETUP_CODE_SHAPE = /^[0-9a-f]{32}$/

const secretsOf = (dataDir: string) => createFileSecretStore(join(dataDir, SECRETS_SUBDIR))

/** Path of the setup-code file for `dataDir`. */
export function setupCodePath(dataDir: string): string {
  return join(dataDir, SECRETS_SUBDIR, SETUP_CODE_KEY)
}

/**
 * While `users` has no account, make sure the setup code exists (written once, reused across restarts
 * until consumed) and return its path; once an account exists, remove any leftover file and return null.
 */
export function ensureSetupCode(dataDir: string, users: UserStore = uiUsers()): string | null {
  if (users.count() > 0) {
    clearSetupCode(dataDir)
    return null
  }
  const store = secretsOf(dataDir)
  const current = store.read(SETUP_CODE_KEY)
  // A malformed file (hand edit, wrong mode -> null) is replaced: it could never be consumed anyway.
  if (current === null || !SETUP_CODE_SHAPE.test(current)) store.write(SETUP_CODE_KEY, randomBytes(SETUP_CODE_BYTES).toString('hex'))
  return setupCodePath(dataDir)
}

const digest = (s: string): Buffer => createHash('sha256').update(s).digest()

/** true (and the file is deleted) when `code` matches; compared in constant time. */
export function consumeSetupCode(dataDir: string, code: string): boolean {
  const store = secretsOf(dataDir)
  const current = store.read(SETUP_CODE_KEY)
  if (current === null || !SETUP_CODE_SHAPE.test(current)) return false
  // Equal-length digests so timingSafeEqual neither throws nor leaks the length.
  if (!timingSafeEqual(digest(code.trim().toLowerCase()), digest(current))) return false
  store.remove(SETUP_CODE_KEY)
  return true
}

/** Delete the setup code if present (setup done some other way, or reset). */
export function clearSetupCode(dataDir: string): void {
  secretsOf(dataDir).remove(SETUP_CODE_KEY)
}
