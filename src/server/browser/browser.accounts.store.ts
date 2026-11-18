// Per-profile account metadata on disk: `<dataRoot>/browser/accounts/<profileId>.json`, mode 0600. Holds only what
// `validateAccount` lets through (provider, state, display name, MASKED email, provider-host avatar, time): no cookies and no
// full address ever reach this file. Not in the workspace SQLite tables on purpose.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isBrowserProfileId } from '../../shared/browser.profile'
import { validateAccounts } from '../../shared/browser.accounts'
import type { ProfileAccount } from '../../shared/browser.accounts'
import { browserRoot } from './profile.paths'
import { createLogger } from '../logs'

const log = createLogger('browser.accounts')
const DIR = 'accounts'
const FILE_MODE = 0o600
const DIR_MODE = 0o700

export interface AccountsStore {
  load(profileId: string): ProfileAccount[]
  save(profileId: string, accounts: readonly ProfileAccount[]): void
  remove(profileId: string): void
}

export function createAccountsStore(dataRoot: string): AccountsStore {
  const dir = join(browserRoot(dataRoot), DIR)
  const fileOf = (id: string): string | null => (isBrowserProfileId(id) ? join(dir, `${id}.json`) : null)
  return {
    load(id) {
      const f = fileOf(id)
      if (!f || !existsSync(f)) return []
      try {
        return validateAccounts(JSON.parse(readFileSync(f, 'utf8')))
      } catch (e) {
        // A damaged file only costs the cache: the next check rewrites it.
        log.warn('browser.accounts.load', 'account cache unreadable; it will be rebuilt', { ids: { profileId: id }, error: e instanceof Error ? e.name : typeof e })
        return []
      }
    },
    save(id, accounts) {
      const f = fileOf(id)
      if (!f) return
      try {
        mkdirSync(dir, { recursive: true, mode: DIR_MODE })
        writeFileSync(f, JSON.stringify(accounts), { mode: FILE_MODE })
        chmodSync(f, FILE_MODE) // writeFileSync keeps the old mode of an existing file
      } catch (e) {
        log.warn('browser.accounts.save', 'account cache not saved', { ids: { profileId: id }, error: e instanceof Error ? e.name : typeof e })
      }
    },
    remove(id) {
      const f = fileOf(id)
      if (f) rmSync(f, { force: true })
    },
  }
}
