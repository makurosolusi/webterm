// Penjaga: teks produk webterm berbahasa Inggris. Gagal bila kata UI Indonesia umum muncul lagi di
// string literal file label/uxText/messages/registry (komentar boleh tetap Indonesia).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('..', import.meta.url))

/** File yang memegang teks produk (label, pesan, katalog kemampuan, deskripsi registry env yang tampil di UI). */
const PRODUCT_TEXT_FILE = /(Labels|labels|\.uxText|Messages)\.ts$|(^|\/)(browser\.status|featureCapabilities|featureCapabilities\.service|envSettings\.state)\.ts$|(^|\/)(browser\.)?envRegistry(\.[a-z0-9]+)?\.ts$|^client\/(Settings[A-Za-z]*\.tsx|QuickOpen\.tsx|uploadQueue\.ts|filesSlot\.upload\.tsx|filesWriteOffer\.tsx|inboxTransport\.ts|terminalLinks\.ts)$/

/** Kata UI Indonesia yang tak punya padanan sama-eja di Inggris (sengaja tanpa "di"/"ke"/"ini": bentrok dengan path/ekstensi). */
const INDONESIAN = [
  'yang', 'dengan', 'tidak', 'belum', 'sudah', 'untuk', 'atau', 'bisa', 'sedang', 'lagi', 'dulu', 'harus', 'tanpa',
  'lewat', 'bila', 'hanya', 'kamu', 'anda', 'nyalakan', 'matikan', 'tersambung', 'kemampuan', 'pengaturan',
  'lanjutan', 'buka', 'salin', 'izinkan', 'atur', 'terkunci', 'pratinjau', 'dipotong', 'periksa', 'gagal', 'simpan',
  'hapus', 'tutup', 'batal', 'pilih', 'coba', 'memuat', 'menyimpan', 'berkas', 'aktif', 'mati', 'proyek', 'kanvas',
  'pesan', 'galat', 'perintah', 'izin', 'persetujuan', 'agen', 'sesi',
]
const WORD = new RegExp(`\\b(${INDONESIAN.join('|')})\\b`, 'i')

/** Nama diri / istilah yang sah walau mirip kata di atas (substring literal yang dibuang sebelum dicek). */
const ALLOW: readonly string[] = []

const LITERAL = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g

/** Literal string berbahasa Indonesia di satu sumber; komentar baris/blok diabaikan. */
function indonesianLiterals(source: string): string[] {
  const hits: string[] = []
  for (const raw of source.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue
    const code = raw.replace(/\s\/\/\s.*$/, '')
    for (const lit of code.match(LITERAL) ?? []) {
      const text = ALLOW.reduce((t, a) => t.replaceAll(a, ''), lit)
      if (WORD.test(text)) hits.push(lit)
    }
  }
  return hits
}

function productTextFiles(): string[] {
  return (readdirSync(SRC, { recursive: true }) as string[])
    .map((f) => f.split('\\').join('/'))
    .filter((f) => PRODUCT_TEXT_FILE.test(f) && !/\.test\.tsx?$/.test(f))
}

describe('product text is English', () => {
  it('detector flags Indonesian and passes English', () => {
    expect(indonesianLiterals(`const a = 'Nyalakan browser'\n// komentar tidak dihitung`)).toEqual([`'Nyalakan browser'`])
    expect(indonesianLiterals(`const a = 'Turn on browser' // tidak dihitung`)).toEqual([])
  })

  it('covers the label, uxText, messages, and registry files', () => {
    const files = productTextFiles()
    for (const f of ['client/browser.uxText.ts', 'client/filesMessages.ts', 'client/capabilitiesLabels.ts',
      'shared/featureCapabilities.ts', 'server/envRegistry.central.ts', 'server/browser/browser.envRegistry.ts']) {
      expect(files).toContain(f)
    }
  })

  it('no Indonesian UI words in product text string literals', () => {
    const offenders = productTextFiles().flatMap((f) =>
      indonesianLiterals(readFileSync(join(SRC, f), 'utf8')).map((lit) => `${f}: ${lit}`))
    expect(offenders).toEqual([])
  })
})
