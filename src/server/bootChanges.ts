// Settings that boot changes on its own (card-linked settings, default-on flags, first-run backfill, the default
// Claude profile) run before the ledger is open. They are queued here and flushed once the ledger is up, as ONE
// Central notice and one `auto.boot_changes` record per boot, and only when something changed. Default-on flags
// apply on every boot, so each one is announced once: the announced set is kept in `central_control`.
import type { Database } from 'bun:sqlite'
import { automaticAction } from './central/automaticAction'
import { readCentralSetting, writeCentralSetting } from './central/centralSetting'

export type BootChangeKind = 'linked' | 'default_on' | 'setup' | 'profile'
const ANNOUNCED = 'boot_defaults_announced'
const LIST_MAX = 6

let queued: { kind: BootChangeKind; keys: string[] }[] = []

/** Queues what boot changed; empty `keys` is ignored. Setting keys only, never values. */
export function queueBootChange(kind: BootChangeKind, keys: readonly string[]): void {
  if (keys.length > 0) queued.push({ kind, keys: [...keys] })
}

const list = (keys: string[]): string => (keys.length > LIST_MAX ? `${keys.slice(0, LIST_MAX).join(', ')} and ${keys.length - LIST_MAX} more` : keys.join(', '))
const PHRASE: Record<BootChangeKind, (keys: string[]) => string> = {
  linked: (k) => `filled settings for features already on (${list(k)})`,
  default_on: (k) => `turned on default features (${list(k)})`,
  setup: () => 'marked first-run setup complete for this existing install',
  profile: () => 'set the default Claude profile to match command mode',
}

/** Posts the batch; returns whether a notice was posted. The queue is emptied either way. */
export function flushBootChanges(db: Database, now: () => number = Date.now): boolean {
  const batch = queued
  queued = []
  const stored = readCentralSetting(db, ANNOUNCED)
  const announced = new Set(Array.isArray(stored) ? stored.filter((x): x is string => typeof x === 'string') : [])
  const parts: string[] = []
  const fresh: string[] = []
  for (const { kind, keys } of batch) {
    const shown = kind === 'default_on' ? keys.filter((k) => !announced.has(k)) : keys
    if (kind === 'default_on') fresh.push(...shown)
    if (shown.length > 0) parts.push(PHRASE[kind](shown))
  }
  if (fresh.length > 0) writeCentralSetting(db, ANNOUNCED, [...new Set([...announced, ...fresh])].sort(), 'system:boot', now())
  if (parts.length === 0) return false
  const at = now()
  return automaticAction({ db, now }, {
    name: 'boot_changes', actor: 'system:boot', subject: 'boot', noticeKey: `auto:boot_changes:${at}`,
    text: `At startup webterm ${parts.join('; ')}, because these were not set yet.`,
  })
}

/** Test hook. */
export function resetBootChangesForTest(): void {
  queued = []
}
