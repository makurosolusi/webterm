// Turunan murni untuk baris env: teks prasyarat (requires) dan penentuan badge Diubah / Perlu restart.
import { evalRequires, type EnvEntryV2, type EnvRequire } from '../shared/envSettings.contract'

const norm = (v: string | undefined): string => (v ?? '').trim().toLowerCase()

/** Prasyarat yang pasti belum terpenuhi; 'unknown' (kunci tak dikenal) tidak pernah jadi peringatan. */
export function unmetRequires(entry: EnvEntryV2, get: (key: string) => string | undefined): EnvRequire[] {
  return evalRequires(entry, get).filter((r) => r.met === false).map((r) => r.require)
}

/** Nilai yang dibutuhkan, untuk teks: `oneOf` digabung "/", kosong = on. */
export const requiredValueText = (r: EnvRequire): string => (r.oneOf?.length ? r.oneOf.join(' / ') : 'on')

/** Diubah = nilai yang ditampilkan berbeda dari default registry (bukan sekadar source==='override'). */
export function isChanged(entry: EnvEntryV2, shown: string): boolean {
  if (entry.kind === 'secret') return entry.source === 'override' && (entry.secretSet ?? entry.set) === true
  return norm(shown) !== norm(entry.default)
}

/** Kunci `boot` yang nilai aktifnya masih beda dari nilai tersimpan (menunggu restart). */
export function activeDiffers(entry: EnvEntryV2): boolean {
  return entry.restart === 'boot' && entry.kind !== 'secret' && entry.value !== '' && entry.effective !== ''
    && norm(entry.effective) !== norm(entry.value)
}

/** Perlu restart: dipastikan server (`pendingRestart`) atau nilai aktif ≠ tersimpan pada kunci `boot`. */
export const needsRestart = (entry: EnvEntryV2): boolean => entry.pendingRestart || activeDiffers(entry)
