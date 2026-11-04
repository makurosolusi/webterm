// Metadata grup env (label, urutan, pemilik). Grup asing diturunkan otomatis: domain baru tak perlu edit file ini.
import type { EnvGroupMeta } from '../shared/envSettings.contract'

const g = (id: string, label: string, order: number, owner: string): [string, EnvGroupMeta] => [id, { id, label, order, owner }]

/** Grup core yang dikenal. */
export const GROUP_META: Readonly<Record<string, EnvGroupMeta>> = Object.fromEntries([
  g('ledger', 'Ledger', 10, 'platform'),
  g('telegram', 'Telegram', 20, 'channels'),
  g('channels', 'Channels', 30, 'channels'),
  g('central', 'Central', 40, 'central'),
  // Sub-grup Central (satu section "Central"; hanya mengurutkan entri di dalamnya).
  g('central-turn', 'Turn limits', 41, 'central'),
  g('central-budget', 'Daily budget', 42, 'central'),
  g('central-context', 'Context & memory', 43, 'central'),
  g('central-lab', 'Experiments', 44, 'central'),
  g('orchestrator', 'Orchestrator', 50, 'platform'),
  g('memory', 'Memory', 60, 'platform'),
  g('control', 'Control', 70, 'platform'),
  g('browser', 'Browser', 75, 'platform'),
  g('files', 'File manager', 78, 'files'),
  g('logs', 'Log', 80, 'logs'),
  g('bootstrap', 'Bootstrap', 90, 'platform'),
])

/** Urutan untuk grup yang tak terdaftar (selalu setelah grup core). */
export const UNKNOWN_GROUP_ORDER = 900

/** Meta grup `id`; grup asing diturunkan `{label:id, order:900, owner:id}`. */
export function groupMetaFor(id: string): EnvGroupMeta {
  return GROUP_META[id] ?? { id, label: id, order: UNKNOWN_GROUP_ORDER, owner: id }
}
