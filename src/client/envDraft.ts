// Logika murni draft + pengelompokan section Environment (tanpa React, mudah diuji).
import type { EnvEntryV2, EnvGroupMeta } from '../shared/envSettings.contract'
import type { EnvChange } from './envSettingsApi'
import { matchesSearch } from './SettingsFields'

/** Entri owner 'channels' dirender tab Channels (ENV-06 menyalakan); sebelum itu tetap di sini. */
export const CHANNELS_OWNS_TELEGRAM: boolean = false

const NO_ORDER = Number.MAX_SAFE_INTEGER

export interface EnvSectionData { title: string; entries: EnvEntryV2[] }
export interface EnvPartition { main: EnvSectionData[]; advanced: EnvSectionData[]; channels: EnvEntryV2[] }
export type EnvQuickFilter = 'changed' | 'restart' | 'dangerous'

/** Draft baru: nilai sama dengan nilai server berarti bukan perubahan (kunci dibuang). */
export function withDraft(draft: ReadonlyMap<string, string>, key: string, value: string, serverValue: string): Map<string, string> {
  const next = new Map(draft)
  if (value === serverValue) next.delete(key)
  else next.set(key, value)
  return next
}

/** Buang draft kunci yang sudah tak ada atau nilainya sama dengan server; sisanya dipertahankan. */
export function reconcileDraft(draft: ReadonlyMap<string, string>, entries: readonly EnvEntryV2[]): Map<string, string> {
  const server = new Map(entries.map((e) => [e.key, e.value]))
  return new Map([...draft].filter(([k, v]) => server.has(k) && server.get(k) !== v))
}

/** Buang draft yang baru saja terkirim (hanya bila belum diedit lagi selama request). */
export function dropSent(draft: ReadonlyMap<string, string>, sent: Readonly<Record<string, string>>): Map<string, string> {
  return new Map([...draft].filter(([k, v]) => sent[k] !== v))
}

/** Badan PUT massal dari draft. */
export function buildChange(draft: ReadonlyMap<string, string>): EnvChange {
  return { set: Object.fromEntries(draft) }
}

/** Nilai kunci: draft menang; secret tak punya nilai di state, jadi 'on' bila terisi; undefined = kunci tak dikenal. */
export function valueOfKey(entries: readonly EnvEntryV2[], draft: ReadonlyMap<string, string>, key: string): string | undefined {
  const e = entries.find((x) => x.key === key)
  if (!e) return undefined
  if (e.kind === 'secret') return (e.secretSet ?? e.set) ? 'on' : ''
  return draft.get(key) ?? e.value
}

/** Entri dianggap diubah: ada draft, atau nilai tersimpan ≠ default dan bukan sumber default. */
export function isChanged(e: EnvEntryV2, draft: ReadonlyMap<string, string>): boolean {
  if (draft.has(e.key)) return true
  return e.kind === 'secret' ? e.source === 'override' : e.source !== 'default' && e.value !== (e.default ?? '')
}

/** Cocok filter cepat (undefined = semua). */
export function matchesQuickFilter(e: EnvEntryV2, filter: EnvQuickFilter | undefined, draft: ReadonlyMap<string, string>): boolean {
  if (filter === 'changed') return isChanged(e, draft)
  if (filter === 'restart') return e.pendingRestart
  if (filter === 'dangerous') return e.dangerous
  return true
}

/** Cocok query pencarian (sudah dinormalisasi): label, KEY, deskripsi, section. */
export function entryMatches(e: EnvEntryV2, query: string): boolean {
  return matchesSearch(`${e.label} ${e.key} ${e.description} ${e.section}`, query)
}

/** Label kunci dangerous yang sedang berada di draft. */
export function dangerousDirtyLabels(entries: readonly EnvEntryV2[], dirtyKeys: readonly string[]): string[] {
  return entries.filter((e) => e.dangerous && dirtyKeys.includes(e.key)).map((e) => e.label)
}

/** Bagi entri: user → section utama, advanced → "Lanjutan"; owner channels dikeluarkan bila channelsOwned. */
export function partitionEntries(
  entries: readonly EnvEntryV2[],
  groups: readonly EnvGroupMeta[],
  channelsOwned: boolean,
): EnvPartition {
  const order = new Map(groups.map((g) => [g.id, g.order]))
  const rank = (e: EnvEntryV2): number => order.get(e.group) ?? NO_ORDER
  const out: EnvPartition = { main: [], advanced: [], channels: [] }
  const ranks = new Map<EnvSectionData, number>()
  for (const e of entries) {
    if (channelsOwned && e.owner === 'channels') { out.channels.push(e); continue }
    const list = e.audience === 'user' ? out.main : out.advanced
    let sec = list.find((s) => s.title === e.section)
    if (!sec) { sec = { title: e.section, entries: [] }; list.push(sec); ranks.set(sec, rank(e)) }
    sec.entries.push(e)
    ranks.set(sec, Math.min(ranks.get(sec) ?? NO_ORDER, rank(e)))
  }
  const byRank = (a: EnvSectionData, b: EnvSectionData): number => (ranks.get(a) ?? NO_ORDER) - (ranks.get(b) ?? NO_ORDER)
  out.main.sort(byRank) // sort stabil: urutan kemunculan mempertahankan seri
  out.advanced.sort(byRank)
  return out
}
