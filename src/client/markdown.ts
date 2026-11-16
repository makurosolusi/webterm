import { Marked, type Tokens } from 'marked'
import DOMPurify from 'dompurify'
import markedFootnote from 'marked-footnote'

/** GitHub's prefix for heading ids in rendered user content: an id can never clobber a DOM global
 *  (`id="location"`), which is also what keeps DOMPurify's SANITIZE_DOM from dropping it. */
export const HEADING_ID_PREFIX = 'user-content-'

const ALERT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'] as const
const ALERT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/i

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }

/** GitHub's heading anchor (github-slugger): lowercase, punctuation dropped, spaces → `-`. */
export function headingSlug(text: string): string {
  return text
    .replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e] ?? e)
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-')
}

// One instance, not the global `marked`: extensions here must not leak into other importers.
// The slug counter is reset per render; `parse` is synchronous, so renders never interleave.
let slugCounts = new Map<string, number>()
const md = new Marked({
  walkTokens(token) {
    // GitHub alerts: `> [!NOTE]` as the first line of a blockquote. The marker is cut from the first
    // text token so it never renders; the blockquote is tagged for the renderer below.
    if (token.type !== 'blockquote') return
    const para = token.tokens?.[0]
    if (para?.type !== 'paragraph') return
    const m = ALERT_RE.exec(para.text)
    const first = para.tokens?.[0]
    if (!m || first?.type !== 'text') return
    first.text = first.text.replace(ALERT_RE, '')
    first.raw = first.raw.replace(ALERT_RE, '')
    ;(token as Tokens.Blockquote & { alert?: string }).alert = m[1]!.toLowerCase()
  },
  renderer: {
    heading({ tokens, depth }) {
      const slug = headingSlug(this.parser.parseInline(tokens, this.parser.textRenderer))
      const n = slugCounts.get(slug) ?? 0
      slugCounts.set(slug, n + 1)
      const id = HEADING_ID_PREFIX + (n ? `${slug}-${n}` : slug)
      return `<h${depth} id="${id}">${this.parser.parseInline(tokens)}</h${depth}>\n`
    },
    blockquote(token) {
      const kind = (token as Tokens.Blockquote & { alert?: string }).alert
      if (!kind || !(ALERT_KINDS as readonly string[]).includes(kind)) return false
      const title = kind[0]!.toUpperCase() + kind.slice(1)
      return `<div class="markdown-alert markdown-alert-${kind}">\n<p class="markdown-alert-title">${title}</p>\n${this.parser.parse(token.tokens)}</div>\n`
    }
  }
})
// GFM footnotes (`[^1]`), ids under the same clobber-safe prefix as headings.
md.use(markedFootnote({ prefixId: `${HEADING_ID_PREFIX}fn-` }))

/**
 * Markdown → HTML yang sudah disanitasi, aman untuk `dangerouslySetInnerHTML`.
 *
 * Render markdown (±10 baris): marked untuk render, DOMPurify
 * untuk sanitasi. SENGAJA tanpa pipeline sendiri — isi file pengguna adalah input tak terpercaya,
 * dan satu sanitizer yang dirawat orang lain lebih aman daripada allowlist tulisan sendiri.
 * Tambahan GitHub: id heading (`user-content-<slug>`), alert (`> [!NOTE]`), footnote (`[^1]`).
 */
export function renderMarkdown(src: string): string {
  slugCounts = new Map()
  const html = md.parse(src || '', { async: false }) as string
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
