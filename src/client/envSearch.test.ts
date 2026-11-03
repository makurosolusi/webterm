import { describe, expect, it } from 'vitest'
import type { EnvEntryV2 } from '../shared/envSettings.contract'
import { matchesEntry } from './envSearch'

// test-only: entri sintetis, tanpa nilai nyata.
const entry = {
  key: 'WEBTERM_LEDGER',
  label: 'Catatan ledger',
  description: 'Menyimpan riwayat transaksi agen',
  section: 'Ledger',
  group: 'ledger',
} as EnvEntryV2

describe('matchesEntry', () => {
  it('matches label, KEY, description, section and group case-insensitively', () => {
    expect(matchesEntry(entry, 'CATATAN')).toBe(true)
    expect(matchesEntry(entry, 'webterm_ledger')).toBe(true)
    expect(matchesEntry(entry, 'RIWAYAT')).toBe(true)
    expect(matchesEntry({ ...entry, section: 'Kanal pesan' }, 'kanal')).toBe(true)
    expect(matchesEntry({ ...entry, group: 'telegram' }, 'Telegram')).toBe(true)
  })

  it('requires every space-separated token and tolerates extra whitespace', () => {
    expect(matchesEntry(entry, '  riwayat   ledger ')).toBe(true)
    expect(matchesEntry(entry, 'riwayat telegram')).toBe(false)
  })

  it('treats an empty query as a match and an unrelated one as a miss', () => {
    expect(matchesEntry(entry, '   ')).toBe(true)
    expect(matchesEntry(entry, 'zzz-tidak-ada')).toBe(false)
  })
})
