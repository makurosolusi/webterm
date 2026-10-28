import { describe, it, expect, vi, beforeEach } from 'vitest'
import { marked } from 'marked'

// BATAS LINGKUNGAN — baca ini sebelum menilai cakupan test di bawah.
//
// Bukti "`<script>` dan handler `on*` hilang" hanya bisa dihasilkan dengan menjalankan DOMPurify
// sungguhan, dan DOMPurify butuh DOM. Vitest di repo ini berjalan node-env, dan TIDAK ADA
// implementasi DOM yang terpasang (jsdom & happy-dom cuma peerDependency vitest, keduanya absen;
// menambah paket dilarang di gelombang ini). Di node, `DOMPurify.isSupported === false` dan
// `DOMPurify.sanitize` bahkan tidak ada sebagai fungsi.
//
// Jadi yang dipaku di sini adalah dua sisi lain dari klaim keamanan yang sama, keduanya assertion
// nyata dan jalan di node:
//   1. sanitizer BENAR-BENAR menanggung beban — marked meneruskan `<script>` dan `onerror=` mentah,
//      jadi output marked tanpa sanitasi memang HTML penyerang;
//   2. satu-satunya pintu keluar `renderMarkdown` adalah sanitizer — HTML mentah itu diserahkan
//      utuh ke `DOMPurify.sanitize` dan yang dikembalikan HANYA hasil sanitizer, dan ketika
//      sanitizer tidak hidup fungsinya melempar, bukan mengembalikan HTML mentah.
// Menjalankan DOMPurify sungguhan terhadap vektor-vektor ini perlu test environment DOM.

const DANGEROUS = '<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">'

const fakePurify = { isSupported: true, sanitize: vi.fn((html: string) => `[clean]${html}`) }
vi.mock('dompurify', () => ({ default: fakePurify }))

const { renderMarkdown } = await import('./markdown')

describe('renderMarkdown', () => {
  beforeEach(() => {
    fakePurify.isSupported = true
    fakePurify.sanitize.mockClear()
  })

  it('merender markdown ke HTML (heading, list, code)', () => {
    const out = renderMarkdown('# Judul\n\n- a\n- b\n\n`kode`')
    expect(out).toContain('<h1')
    expect(out).toContain('Judul')
    expect(out).toContain('<ul>')
    expect(out).toContain('<code>kode</code>')
  })

  it('sanitizer menanggung beban: marked meneruskan <script> dan on* mentah', () => {
    const raw = marked.parse(DANGEROUS, { async: false }) as string
    expect(raw).toContain('<script>')
    expect(raw).toContain('onerror=')
  })

  it('meneruskan HTML mentah itu ke DOMPurify dan mengembalikan HANYA hasil sanitizer', () => {
    const out = renderMarkdown(DANGEROUS)
    expect(fakePurify.sanitize).toHaveBeenCalledTimes(1)
    const handed = fakePurify.sanitize.mock.calls[0][0]
    expect(handed).toContain('<script>')
    expect(handed).toContain('onerror=')
    // Nilai balik identik dengan apa yang dikembalikan sanitizer: tidak ada jalur yang
    // menggabungkan atau melewati hasilnya.
    expect(out).toBe(`[clean]${handed}`)
  })

  it('melempar (fail closed), bukan mengembalikan HTML, saat sanitizer tidak tersedia', () => {
    fakePurify.isSupported = false
    expect(() => renderMarkdown(DANGEROUS)).toThrow(/DOMPurify/)
    expect(fakePurify.sanitize).not.toHaveBeenCalled()
  })

  it('menerima string kosong tanpa melempar', () => {
    expect(renderMarkdown('')).toBe('[clean]')
  })
})
