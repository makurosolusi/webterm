// Penjaga: teks produk webterm berbahasa Inggris. Memindai SEMUA sumber non-test di src/client, src/server,
// src/shared (bukan cuma file label): kode setelah komentar dibuang, jadi string literal, template, JSX text,
// pesan error/log, dan prompt model ikut terperiksa. Versi lama hanya memindai file *Labels/*Messages dan
// daftar kata sempit, sehingga "Batas tertinggi" (centralLabels.ts) lolos.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('..', import.meta.url))
const AREAS = ['client', 'server', 'shared']

/** Kata Indonesia yang tak punya padanan sama-eja di Inggris (sengaja tanpa "di"/"ke"/"ini"/"ada": bentrok dengan path/ekstensi/nama). */
const INDONESIAN = [
  'yang', 'dan', 'dengan', 'tidak', 'tak', 'belum', 'sudah', 'untuk', 'atau', 'bisa', 'sedang', 'lagi', 'dulu', 'harus',
  'tanpa', 'lewat', 'bila', 'jika', 'kalau', 'karena', 'supaya', 'hanya', 'juga', 'saja', 'bukan', 'telah', 'tersebut',
  'kamu', 'anda', 'silakan', 'mohon', 'harap', 'lainnya', 'nyalakan', 'matikan', 'tersambung', 'terpasang', 'kemampuan',
  'pengaturan', 'lanjutan', 'buka', 'salin', 'izinkan', 'atur', 'terkunci', 'pratinjau', 'dipotong', 'periksa', 'gagal',
  'berhasil', 'simpan', 'hapus', 'tutup', 'batal', 'pilih', 'coba', 'memuat', 'menyimpan', 'berkas', 'proyek', 'kanvas',
  'pesan', 'galat', 'kesalahan', 'perintah', 'izin', 'persetujuan', 'agen', 'sesi', 'batas', 'tertinggi', 'terendah',
  'rusak', 'cocok',
]
const WORD = new RegExp(`\\b(${INDONESIAN.join('|')})\\b`, 'gi')

/** Non-Inggris yang sah: `file` relatif ke src, `text` dibuang dari kode sebelum dicek, `reason` wajib. */
const ALLOW: readonly { file: string; text: string; reason: string }[] = [
  { file: 'server/central/skills/skillLint.ts', text: String.raw`/abaikan\s+(semua\s+)?(aturan|instruksi|perintah)/i`,
    reason: 'detector for Indonesian prompt-injection phrasing; never shown to anyone' },
]

/**
 * Seluruh file dikecualikan: hanya kosakata INPUT user (pencocok intent), bukan teks produk. Sempit by design:
 * file wajib berisi konstanta RegExp saja (test di bawah menolak string/template), jadi teks produk tak bisa
 * menumpang di sini.
 */
const USER_INPUT_VOCAB: readonly { file: string; reason: string }[] = [
  { file: 'server/central/playbooks/playbook.intentWords.ts',
    reason: 'Indonesian intent keywords matched against user messages; never shown to anyone' },
]

/** Buang komentar `//`, `/* *\/` dan baris komentar SQL `-- ` di dalam template; string, template, regex utuh. */
function stripComments(src: string): string {
  let out = ''
  let i = 0
  const n = src.length
  const interp: number[] = []
  let depth = 0
  let last = ''
  const regexAllowed = () => last === '' || /[(,=:[!&|?{};+\-*%<>~^]$/.test(last) || /\b(return|typeof|case|in|of|throw|yield|await)$/.test(last)
  const template = () => {
    while (i < n) {
      if (src[i] === '\\') { out += src.slice(i, i + 2); i += 2; continue }
      if (src[i] === '`') { out += '`'; i++; return }
      if (src[i] === '$' && src[i + 1] === '{') { out += '${'; i += 2; interp.push(depth++); return }
      out += src[i++]
    }
  }
  while (i < n) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2) < 0 ? n : src.indexOf('*/', i + 2) + 2
      out += src.slice(i, end).replace(/[^\n]/g, '')
      i = end
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1
      out += src.slice(i, j + 1); i = j + 1; last = 'a'; continue
    }
    if (c === '`') { out += c; i++; template(); last = 'a'; continue }
    if (c === '}' && interp.length && interp[interp.length - 1] === depth - 1) {
      interp.pop(); depth--; out += c; i++; template(); last = 'a'; continue
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1
      let cls = false
      while (j < n && src[j] !== '\n' && (cls || src[j] !== '/')) {
        if (src[j] === '\\') j++
        else if (src[j] === '[') cls = true
        else if (src[j] === ']') cls = false
        j++
      }
      if (src[j] === '/') { out += src.slice(i, j + 1); i = j + 1; last = 'a'; continue }
    }
    if (c === '{') depth++
    if (c === '}') depth--
    out += c
    i++
    if (!/\s/.test(c)) last = (last + c).slice(-8)
  }
  return out.replace(/^[ \t]*-- .*$/gm, '')
}

/** Baris kode (tanpa komentar) yang memuat kata Indonesia, sebagai `baris: kata`. */
function indonesianHits(source: string, allow: readonly string[] = []): string[] {
  const code = allow.reduce((t, a) => t.replaceAll(a, ''), stripComments(source))
  return code.split('\n').flatMap((line, k) => [...line.matchAll(WORD)].map((m) => `${k + 1}: ${m[0]}`))
}

function sourceFiles(): string[] {
  return AREAS.flatMap((area) => (readdirSync(join(SRC, area), { recursive: true }) as string[])
    .map((f) => `${area}/${f.split('\\').join('/')}`))
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$|\.d\.ts$|__fixtures__\//.test(f))
}

describe('product text is English', () => {
  it('detector flags Indonesian in strings and JSX text, ignores comments', () => {
    expect(indonesianHits(`const a = 'Batas tertinggi'\n// komentar tidak dihitung`)).toEqual(['1: Batas', '1: tertinggi'])
    expect(indonesianHits(`<p>\n  Tidak ada setting\n</p>`)).toEqual(['2: Tidak'])
    expect(indonesianHits('const b = `x ${y} gagal`')).toEqual(['1: gagal'])
    expect(indonesianHits(`const a = 'Turn on' // tidak dihitung\n/* belum\n dihitung */ const r = /\\/\\//`)).toEqual([])
    expect(indonesianHits('const q = `\n  -- komentar SQL tidak dihitung\n  SELECT 1`')).toEqual([])
  })

  it('scans every non-test source file in client, server and shared', () => {
    const files = sourceFiles()
    expect(files.length).toBeGreaterThan(500)
    for (const f of ['client/central/centralLabels.ts', 'client/SettingsPanel.tsx', 'server/index.ts', 'shared/featureCapabilities.ts']) {
      expect(files).toContain(f)
    }
  })

  it('every allowlist entry still matches its file (no stale exemptions)', () => {
    for (const a of ALLOW) expect(readFileSync(join(SRC, a.file), 'utf8'), `${a.file}: ${a.reason}`).toContain(a.text)
  })

  it('user-input vocabulary files exist and hold only regex constants (no product text can hide there)', () => {
    for (const v of USER_INPUT_VOCAB) {
      const code = stripComments(readFileSync(join(SRC, v.file), 'utf8'))
      expect(code, `${v.file}: ${v.reason}`).not.toMatch(/['"`]/)
      expect(code).toMatch(/\/\\b\(/)
    }
  })

  it('no Indonesian words in product text', () => {
    const vocab = new Set(USER_INPUT_VOCAB.map((v) => v.file))
    const offenders = sourceFiles().filter((f) => !vocab.has(f)).flatMap((f) => {
      const allow = ALLOW.filter((a) => a.file === f).map((a) => a.text)
      return indonesianHits(readFileSync(join(SRC, f), 'utf8'), allow).map((h) => `${f}:${h}`)
    })
    expect(offenders).toEqual([])
  })
})
