// Metadata grup env (label, urutan, pemilik). Grup asing diturunkan otomatis: domain baru tak perlu edit file ini.
import type { EnvGroupMeta } from '../shared/envSettings.contract'

const g = (id: string, label: string, order: number, owner: string): [string, EnvGroupMeta] => [id, { id, label, order, owner }]

/** Grup core yang dikenal. */
export const GROUP_META: Readonly<Record<string, EnvGroupMeta>> = Object.fromEntries([
  g('ledger', 'Ledger', 10, 'platform'),
  g('telegram', 'Telegram', 20, 'channels'),
  g('channels', 'Kanal', 30, 'channels'),
  g('central', 'Central', 40, 'central'),
  g('orchestrator', 'Orkestrator', 50, 'platform'),
  g('memory', 'Memori', 60, 'platform'),
  g('control', 'Kontrol', 70, 'platform'),
  g('browser', 'Browser', 75, 'platform'),
  g('logs', 'Log', 80, 'logs'),
  g('bootstrap', 'Bootstrap', 90, 'platform'),
])

/** Urutan untuk grup yang tak terdaftar (selalu setelah grup core). */
export const UNKNOWN_GROUP_ORDER = 900

/** Meta grup `id`; grup asing diturunkan `{label:id, order:900, owner:id}`. */
export function groupMetaFor(id: string): EnvGroupMeta {
  return GROUP_META[id] ?? { id, label: id, order: UNKNOWN_GROUP_ORDER, owner: id }
}
