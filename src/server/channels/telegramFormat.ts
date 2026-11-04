// CommonMark (LLM output) -> Telegram Bot API HTML subset, plus tag-balanced chunking.
// Imitates OpenClaw `extensions/telegram/src/format.ts` (markdown parser -> <b>/<i>/<s>/<code>/
// <pre><code class="language-x">/<a>/<blockquote>, escape & < >, wrap auto-linkable file names in
// <code>, split rendered HTML re-opening open tags). Parser: `marked` lexer (already a dependency).
// Only tags listed at core.telegram.org/bots/api#html-style are emitted.
import { Lexer, type Token, type Tokens } from 'marked'

/** Escape the three characters Telegram HTML requires (`&`, `<`, `>`); `"` too for attributes. */
export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// File extensions that are also TLDs: Telegram auto-links `note.md` as a domain. Same list as
// OpenClaw `src/shared/text/auto-linked-file-ref.ts` FILE_REF_EXTENSIONS.
const FILE_REF_RE = /(^|[^\w\-/])([\w.\-/]+\.(?:md|go|py|pl|sh|am|at|be|cc))(?=$|[^\w\-/])/gi
const SAFE_HREF_RE = /^(?:https?:\/\/|tg:\/\/|mailto:|tel:)/i

function text(raw: string): string {
  return escapeTelegramHtml(raw).replace(FILE_REF_RE, (match, pre: string, name: string) =>
    name.startsWith('//') ? match : `${pre}<code>${name}</code>`
  )
}

function inline(tokens: Token[] | undefined): string {
  return (tokens ?? []).map(inlineToken).join('')
}

function inlineToken(token: Token): string {
  switch (token.type) {
    case 'strong': return `<b>${inline((token as Tokens.Strong).tokens)}</b>`
    case 'em': return `<i>${inline((token as Tokens.Em).tokens)}</i>`
    case 'del': return `<s>${inline((token as Tokens.Del).tokens)}</s>`
    case 'codespan': return `<code>${escapeTelegramHtml((token as Tokens.Codespan).text)}</code>`
    case 'br': return '\n'
    case 'link': {
      const link = token as Tokens.Link
      const label = inline(link.tokens)
      // Telegram rejects relative/local hrefs for the whole message; keep the label instead.
      return SAFE_HREF_RE.test(link.href) ? `<a href="${escapeTelegramHtml(link.href)}">${label}</a>` : label
    }
    case 'image': {
      const image = token as Tokens.Image
      return SAFE_HREF_RE.test(image.href) ? `<a href="${escapeTelegramHtml(image.href)}">${escapeTelegramHtml(image.text || image.href)}</a>` : escapeTelegramHtml(image.text)
    }
    case 'text': {
      const t = token as Tokens.Text
      return t.tokens ? inline(t.tokens) : text(t.text)
    }
    case 'escape': return escapeTelegramHtml((token as Tokens.Escape).text)
    default: return text('raw' in token ? String(token.raw) : '') // inline html etc.: literal
  }
}

/** Visible text of inline tokens, for table cells inside <pre>. */
function plain(tokens: Token[] | undefined): string {
  return (tokens ?? [])
    .map((token) => ('tokens' in token && token.tokens ? plain(token.tokens) : 'text' in token ? String(token.text) : ''))
    .join('')
}

function table(token: Tokens.Table): string {
  const rows = [token.header.map((cell) => plain(cell.tokens)), ...token.rows.map((row) => row.map((cell) => plain(cell.tokens)))]
  const widths = rows[0]!.map((_, col) => Math.max(...rows.map((row) => (row[col] ?? '').length)))
  const line = (row: string[]): string => row.map((cell, col) => cell.padEnd(widths[col]!)).join(' | ').trimEnd()
  const body = [line(rows[0]!), widths.map((w) => '-'.repeat(w)).join('-|-'), ...rows.slice(1).map(line)]
  return `<pre>${escapeTelegramHtml(body.join('\n'))}</pre>`
}

function blocks(tokens: Token[], depth = 0): string {
  return tokens.map((token) => block(token, depth)).filter(Boolean).join('\n\n')
}

function block(token: Token, depth: number): string {
  switch (token.type) {
    case 'space': case 'def': return ''
    case 'heading': return `<b>${inline((token as Tokens.Heading).tokens).replace(/<\/?b>/g, '')}</b>` // no <b><b>
    case 'paragraph': return inline((token as Tokens.Paragraph).tokens)
    case 'text': return inlineToken(token)
    case 'hr': return '──────────'
    case 'code': {
      const code = token as Tokens.Code
      const lang = (code.lang ?? '').trim().split(/\s/)[0]
      const open = lang ? `<pre><code class="language-${escapeTelegramHtml(lang)}">` : '<pre><code>'
      return `${open}${escapeTelegramHtml(code.text)}</code></pre>`
    }
    case 'blockquote': return `<blockquote>${blocks((token as Tokens.Blockquote).tokens, depth)}</blockquote>`
    case 'list': {
      const list = token as Tokens.List
      const start = typeof list.start === 'number' ? list.start : 1
      return list.items
        .map((item, i) => {
          const marker = list.ordered ? `${start + i}. ` : item.task ? (item.checked ? '☑ ' : '☐ ') : '• '
          const body = item.tokens.map((t) => block(t, depth + 1)).filter(Boolean).join('\n')
          return `${'  '.repeat(depth)}${marker}${body}`
        })
        .join('\n')
    }
    case 'table': return table(token as Tokens.Table)
    default: return text('raw' in token ? String(token.raw).trim() : '') // raw html block: literal
  }
}

/** Convert Markdown to Telegram HTML. Never throws: on a parser failure the text is escaped as-is. */
export function markdownToTelegramHtml(markdown: string): string {
  try {
    return blocks(new Lexer({ gfm: true }).lex(markdown)).trim()
  } catch {
    // Fallback on purpose (Rule 11 note): malformed input must still deliver, as literal text.
    return escapeTelegramHtml(markdown)
  }
}

/** Visible text of Telegram HTML: tags stripped, the four supported entities decoded. */
export function telegramHtmlToPlain(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}

const TAG_RE = /<(\/?)([a-z-]+)[^>]*>/g

/**
 * Split Telegram HTML into chunks of at most `limit` characters (HTML length, conservative vs the
 * API's post-parse count). Open tags are closed at a cut and re-opened in the next chunk; text is
 * cut at the last newline/space and never inside an entity. Same idea as OpenClaw
 * `splitTelegramHtmlChunks`.
 */
export function splitTelegramHtml(html: string, limit: number): string[] {
  if (html.length <= limit) return [html]
  const chunks: string[] = []
  const open: Array<{ name: string; raw: string }> = []
  let current = ''
  let payload = false
  const closing = (): string => open.map((t) => `</${t.name}>`).reverse().join('')
  const flush = (): void => {
    if (payload) chunks.push(current + closing())
    current = open.map((t) => t.raw).join('')
    payload = false
  }
  const appendText = (segment: string): void => {
    let rest = segment
    while (rest) {
      const room = limit - current.length - closing().length
      if (rest.length <= room) {
        current += rest
        payload = true
        return
      }
      let cut = Math.max(rest.lastIndexOf('\n', room), rest.lastIndexOf(' ', room))
      if (cut <= 0) cut = room
      const amp = rest.lastIndexOf('&', cut - 1)
      if (amp >= 0 && rest.indexOf(';', amp) >= cut) cut = amp // keep `&amp;` whole
      if (cut <= 0) {
        if (!payload) throw new Error(`telegram chunk limit ${limit} too small for open tags`)
        flush()
        continue
      }
      current += rest.slice(0, cut)
      payload = true
      rest = rest.slice(cut).replace(/^[ \n]/, '')
      flush()
    }
  }
  let last = 0
  for (const match of html.matchAll(TAG_RE)) {
    appendText(html.slice(last, match.index))
    const [raw, slash, name] = match as unknown as [string, string, string]
    if (slash) {
      const at = open.map((t) => t.name).lastIndexOf(name)
      if (at >= 0) open.splice(at, 1)
      current += raw
    } else {
      // Start a fresh chunk rather than open a tag that cannot fit with its own close.
      if (payload && current.length + raw.length + closing().length + name.length + 3 > limit) flush()
      current += raw
      open.push({ name, raw })
    }
    last = match.index + raw.length
  }
  appendText(html.slice(last))
  flush()
  return chunks
}
