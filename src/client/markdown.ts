import { marked } from 'marked'
import DOMPurify from 'dompurify'

/**
 * Markdown → HTML yang sudah disanitasi, aman untuk `dangerouslySetInnerHTML`.
 *
 * Port dari nodeterm `src/renderer/lib/markdown.ts` (±10 baris): marked untuk render, DOMPurify
 * untuk sanitasi. SENGAJA tanpa pipeline sendiri — isi file pengguna adalah input tak terpercaya,
 * dan satu sanitizer yang dirawat orang lain lebih aman daripada allowlist tulisan sendiri.
 * Opsi `breaks` nodeterm tidak diport: ia hanya dipakai sticky note, yang belum ada di webterm.
 */
export function renderMarkdown(src: string): string {
  const html = marked.parse(src || '', { async: false }) as string
  // FAIL CLOSED di batas kepercayaan. marked meneruskan HTML mentah apa adanya (lihat
  // markdown.test.ts), jadi tanpa sanitizer yang hidup nilai balik fungsi ini adalah HTML
  // penyerang. Di luar browser (vitest node-env) DOMPurify tidak punya DOM dan `sanitize` bahkan
  // tidak ada — melempar dengan konteks jauh lebih baik daripada TypeError misterius, dan yang
  // penting: TIDAK ADA cabang yang mengembalikan HTML tanpa melewati sanitizer.
  if (!DOMPurify.isSupported) {
    throw new Error('renderMarkdown: DOMPurify sanitizer unavailable (needs a DOM) — render aborted')
  }
  return DOMPurify.sanitize(html)
}
