/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { renderMarkdown } from './markdown'

// LINGKUNGAN — file ini SATU-SATUNYA yang menyalakan DOM (lihat docblock di baris 1); 27 file test
// lain tetap node-env. DOMPurify butuh DOM nyata, dan di sini ia dijalankan SUNGGUHAN di atas
// jsdom 30 — jadi assertion di bawah adalah output sanitizer yang betulan, bukan tiruan.
//
// PERINGATAN untuk penerus: jangan tukar jsdom dengan happy-dom. Diukur: happy-dom 21.0.4 +
// DOMPurify 3.4.17 TIDAK MENYANITASI SAMA SEKALI — `<script>` dan `onerror=` lolos utuh sementara
// tag sah justru dibuang, dan `isSupported` tetap `true` sehingga guard fail-closed markdown.ts
// tidak kebagian menolak. Sebabnya getter `Node.prototype.nodeName` mengembalikan `''` saat
// dipanggil unapplied (happy-dom issue #1810) dan `NodeIterator`-nya cuma pembungkus `TreeWalker`
// tanpa pre-removing steps sehingga penelusuran mati setelah penghapusan pertama (issue #2310).
// Memaku assertion ke DOM palsu semacam itu mengunci kebohongan: mutan seperti menambah `script`
// ke ALLOWED_TAGS akan tetap tampak "lulus".
//
// Catatan mekanis: regex pendeteksi docblock environment vitest 5 memindai SELURUH isi file, jadi
// tokennya sengaja tidak diulang di komentar ini — menyebutnya saja sudah mengubah environment.

const DANGEROUS = '<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">'

afterEach(() => {
  vi.restoreAllMocks()
  DOMPurify.isSupported = true
})

describe('renderMarkdown', () => {
  it('berjalan di atas DOMPurify sungguhan (bukan tiruan)', () => {
    expect(DOMPurify.isSupported).toBe(true)
    expect(DOMPurify.version).toBe('3.4.17')
  })

  it('merender markdown sah dan TIDAK membuangnya saat sanitasi', () => {
    expect(renderMarkdown('# Judul\n\n- a\n- b\n\n`kode`')).toBe(
      '<h1>Judul</h1>\n<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n<p><code>kode</code></p>\n',
    )
  })

  it('mempertahankan tautan http(s) biasa apa adanya', () => {
    expect(renderMarkdown('[tautan](https://example.com)')).toBe(
      '<p><a href="https://example.com">tautan</a></p>\n',
    )
  })

  it('sanitizer menanggung beban: marked meneruskan <script> dan on* mentah', () => {
    const raw = marked.parse(DANGEROUS, { async: false }) as string
    expect(raw).toContain('<script>')
    expect(raw).toContain('onerror=')
  })

  it('membuang <script> dan handler on* dari HTML mentah di dalam markdown', () => {
    const out = renderMarkdown(DANGEROUS)
    expect(out).toBe('<img src="x">')
    expect(out).not.toContain('script')
    expect(out).not.toContain('onerror')
  })

  it('melucuti href javascript: tapi mempertahankan teks tautannya', () => {
    const out = renderMarkdown('<a href="javascript:alert(3)">klik</a>')
    expect(out).toBe('<p><a>klik</a></p>\n')
    expect(out).not.toContain('javascript:')
  })

  it('membuang iframe dan handler pada svg', () => {
    const out = renderMarkdown('<iframe src="https://evil.test"></iframe><svg onload=alert(4)></svg>')
    expect(out).not.toContain('iframe')
    expect(out).not.toContain('onload')
  })

  it('menyerahkan HTML mentah utuh ke sanitizer dan mengembalikan HANYA hasilnya', () => {
    const spy = vi.spyOn(DOMPurify, 'sanitize')
    const out = renderMarkdown(DANGEROUS)
    expect(spy).toHaveBeenCalledTimes(1)
    const handed = String(spy.mock.calls[0]?.[0])
    expect(handed).toContain('<script>')
    expect(handed).toContain('onerror=')
    // Nilai balik identik dengan apa yang dikembalikan sanitizer: tidak ada jalur yang
    // menggabungkan atau melewati hasilnya.
    expect(out).toBe(spy.mock.results[0]?.value)
  })

  it('melempar (fail closed), bukan mengembalikan HTML, saat sanitizer tidak tersedia', () => {
    const spy = vi.spyOn(DOMPurify, 'sanitize')
    DOMPurify.isSupported = false
    expect(() => renderMarkdown(DANGEROUS)).toThrow(/DOMPurify/)
    expect(spy).not.toHaveBeenCalled()
  })

  it('menerima string kosong tanpa melempar', () => {
    expect(renderMarkdown('')).toBe('')
  })
})
