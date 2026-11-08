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
      '<h1 id="user-content-judul">Judul</h1>\n<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n<p><code>kode</code></p>\n',
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

describe('renderMarkdown: GitHub heading ids and alerts', () => {
  it('gives headings GitHub-style user-content-* ids, deduped per render', () => {
    const out = renderMarkdown('## Hi `there` & You!\n\n## Setup\n\n## Setup')
    expect(out).toContain('<h2 id="user-content-hi-there--you">Hi <code>there</code> &amp; You!</h2>')
    expect(out).toContain('<h2 id="user-content-setup">Setup</h2>')
    expect(out).toContain('<h2 id="user-content-setup-1">Setup</h2>')
    // The counter resets: a second render starts again at the bare slug.
    expect(renderMarkdown('## Setup')).toBe('<h2 id="user-content-setup">Setup</h2>\n')
  })

  it('renders > [!NOTE] as a GitHub alert without the marker', () => {
    const out = renderMarkdown('> [!WARNING]\n> Mind the **gap**')
    const host = document.createElement('div')
    host.innerHTML = out
    const alert = host.querySelector('.markdown-alert.markdown-alert-warning')
    expect(alert).not.toBeNull()
    expect(alert!.querySelector('.markdown-alert-title')!.textContent).toBe('Warning')
    expect(alert!.textContent).not.toContain('[!WARNING]')
    expect(alert!.querySelector('strong')!.textContent).toBe('gap')
    expect(host.querySelector('blockquote')).toBeNull()
  })

  it('leaves an ordinary blockquote alone', () => {
    expect(renderMarkdown('> just [!quoted]')).toBe('<blockquote>\n<p>just [!quoted]</p>\n</blockquote>\n')
  })
})

describe('renderMarkdown: footnotes', () => {
  it('renders [^1] as a linked footnote with a clobber-safe id', () => {
    const host = document.createElement('div')
    host.innerHTML = renderMarkdown('Hi[^1].\n\n[^1]: The **note**.\n')
    const ref = host.querySelector('sup a')!
    expect(ref.getAttribute('href')).toBe('#user-content-fn-1')
    expect(host.querySelector('#user-content-fn-1')!.textContent).toContain('The note')
    expect(host.textContent).not.toContain('[^1]')
  })
})
