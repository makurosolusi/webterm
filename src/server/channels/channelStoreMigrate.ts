// channels.json v1 -> v2 (RND/26 §3.4): additive `accounts` registry, binding and dedupe keys gain
// the account segment (`channel:accountId:id`), and everything pre-existing moves to the `default`
// account. Pure transform plus one backup helper; the store decides when to write. Tokens never
// live in this document, so nothing here can carry a secret.
import { chmodSync, copyFileSync, constants } from 'node:fs'

/** Account that every v1 row (single global bot) migrates to, and the implicit one when callers omit it. */
export const DEFAULT_ACCOUNT_ID = 'default'
export const STORE_V1_BACKUP_SUFFIX = '.v1.bak'

export type ChannelAccountState = 'active' | 'paused' | 'revoked'

/** One bot/account of a channel kind; the token is in the secret store, never here. */
export interface ChannelAccount {
  kind: string
  username: string
  purpose: string
  state: ChannelAccountState
  managed: boolean
  createdAt: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function withAccount(table: unknown): unknown {
  if (!isRecord(table)) return table
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(table)) {
    const at = key.indexOf(':')
    out[at > 0 ? `${key.slice(0, at)}:${DEFAULT_ACCOUNT_ID}${key.slice(at)}` : key] = value
  }
  return out
}

/** Rewrites a parsed v1 document into v2 shape; malformed parts pass through for strict validation to reject. */
export function migrateStoreV1(v1: Record<string, unknown>, now: number): Record<string, unknown> {
  const account: ChannelAccount = {
    kind: 'telegram',
    username: '',
    purpose: DEFAULT_ACCOUNT_ID,
    state: 'active',
    managed: false,
    createdAt: now,
  }
  return {
    ...v1,
    version: 2,
    accounts: { [DEFAULT_ACCOUNT_ID]: account },
    bindings: withAccount(v1['bindings']),
    processed: withAccount(v1['processed']),
  }
}

/** Strict `accounts` check; null when the shape drifted. */
export function parseAccounts(value: unknown): Record<string, ChannelAccount> | null {
  if (!isRecord(value)) return null
  const out: Record<string, ChannelAccount> = {}
  for (const [id, raw] of Object.entries(value)) {
    if (!id || id.includes(':') || !isRecord(raw)) return null
    const { kind, username, purpose, state, managed, createdAt } = raw
    if (typeof kind !== 'string' || !kind || typeof username !== 'string' || typeof purpose !== 'string') return null
    if (state !== 'active' && state !== 'paused' && state !== 'revoked') return null
    if (typeof managed !== 'boolean' || typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null
    out[id] = { kind, username, purpose, state, managed, createdAt }
  }
  return out
}

/**
 * Copy the v1 file to `<path>.v1.bak` (0600) before the first v2 write. An existing backup is kept:
 * it holds the original v1 even if a crash made this run repeat. Throws on any other failure.
 */
export function backupStoreV1(path: string): void {
  const target = `${path}${STORE_V1_BACKUP_SUFFIX}`
  try {
    copyFileSync(path, target, constants.COPYFILE_EXCL)
    chmodSync(target, 0o600)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
}
