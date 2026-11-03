// Pencocokan pencarian untuk entri Environment: fungsi murni, dipakai SettingsPanel (hitungan +
// tautan hasil Channels) dan EnvSection/EnvEntryRow (menyembunyikan baris yang tak cocok).
import type { EnvEntryV2 } from '../shared/envSettings.contract'
import { matchesSearch, normalizeQuery } from './SettingsFields'

/** Nama atribut baris env di DOM; hitungan DOM Settings mengecualikannya (env dihitung dari state). */
export const ENV_KEY_ATTR = 'data-env-key'

/** Cocok bila SEMUA token query (dipisah spasi, case-insensitive) ada di label/KEY/deskripsi/section/grup. */
export function matchesEntry(entry: EnvEntryV2, query: string): boolean {
  const haystack = [entry.label, entry.key, entry.description, entry.section, entry.group].join(' ')
  return matchesSearch(haystack, normalizeQuery(query))
}
