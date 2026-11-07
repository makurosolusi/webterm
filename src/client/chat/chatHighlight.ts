// Syntax colors for the code blocks of rendered chat Markdown. Runs on the sanitized DOM after
// render: the text of each `<pre><code class="language-x">` is tokenized and rebuilt as `<span>`s whose
// content is set with textContent, so no HTML is ever parsed and the sanitizer's guarantee holds.
// Colors come from CSS classes (`chat-tok--<kind>`, chat.css) that follow the app theme (light/dark).
// The tokenizer is Monaco's (already installed for the editor nodes, chatHighlight.monaco.ts), loaded
// lazily on the first block that names a language.

/** One run of text of a line; `kind` = token class (keyword, string, ...), none = plain. */
export interface CodeToken { text: string; kind?: string }
/** Tokens per line of `code`, or null when the language is unknown (the block stays plain). */
export type Tokenize = (code: string, lang: string) => Promise<CodeToken[][] | null>

/** Longer blocks stay plain: tokenizing is synchronous on the main thread. */
export const HIGHLIGHT_MAX_CHARS = 50_000
const DONE_ATTR = 'data-highlighted'

/** Token kinds with a color in chat.css (Monarch token names: `keyword.ts` -> keyword). */
const KINDS = new Set(['keyword', 'string', 'comment', 'number', 'type', 'regexp', 'tag', 'attribute', 'variable', 'constant', 'predefined', 'annotation', 'metatag', 'operator', 'key'])

/** CSS kind of a tokenizer token type, undefined = plain text. */
export function tokenKind(type: string): string | undefined {
  const head = type.split('.')[0] ?? ''
  return KINDS.has(head) ? head : undefined
}

function languageOf(code: Element): string | undefined {
  return /(?:^|\s)language-([\w+#.-]+)/.exec(code.className)?.[1]?.toLowerCase()
}

function render(lines: CodeToken[][]): DocumentFragment {
  const frag = document.createDocumentFragment()
  lines.forEach((line, i) => {
    if (i > 0) frag.append('\n')
    for (const t of line) {
      if (!t.kind) { frag.append(t.text); continue }
      const span = document.createElement('span')
      span.className = `chat-tok chat-tok--${t.kind}`
      span.textContent = t.text
      frag.append(span)
    }
  })
  return frag
}

/** Colors every not-yet-highlighted code block under `root` that names a language. */
export async function highlightCodeBlocks(root: HTMLElement, tokenize: Tokenize): Promise<void> {
  for (const code of Array.from(root.querySelectorAll('pre > code'))) {
    const lang = languageOf(code)
    if (!lang || code.hasAttribute(DONE_ATTR)) continue
    const text = code.textContent ?? ''
    if (!text || text.length > HIGHLIGHT_MAX_CHARS) continue
    const lines = await tokenize(text.replace(/\n$/, ''), lang)
    // The message may have re-rendered (streaming) while the tokenizer loaded: never paint stale text.
    if (!lines || !code.isConnected || code.textContent !== text) continue
    code.replaceChildren(render(lines), ...(text.endsWith('\n') ? ['\n'] : []))
    code.setAttribute(DONE_ATTR, '')
  }
}
