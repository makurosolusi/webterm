import { describe, expect, it } from 'vitest'

import { escapeTelegramHtml, markdownToTelegramHtml, splitTelegramHtml, telegramHtmlToPlain } from './telegramFormat'
import { sendTelegramMarkdown, type TelegramSenderFetch } from './telegramSend'

// test-only: fake token, never a real one.
const ENV = () => ({ WEBTERM_TELEGRAM_BOT_TOKEN: '1:TEST' }) as NodeJS.ProcessEnv

// Tags allowed by core.telegram.org/bots/api#html-style that this converter may emit.
const ALLOWED = new Set(['b', 'i', 's', 'code', 'pre', 'a', 'blockquote'])

function assertBalanced(html: string): void {
  const stack: string[] = []
  for (const [, slash, name] of html.matchAll(/<(\/?)([a-z-]+)[^>]*>/g)) {
    expect(ALLOWED.has(name!)).toBe(true)
    if (slash) expect(stack.pop()).toBe(name)
    else stack.push(name!)
  }
  expect(stack).toEqual([])
  // Every `&` outside a tag starts one of the entities Telegram supports.
  expect(html.replace(/&(amp|lt|gt|quot);/g, '')).not.toMatch(/&/)
}

// The reply from the user's screenshot (Central agent, CommonMark).
const SCREENSHOT = [
  'Proyek **laya-api**',
  '',
  '- **Status:** active',
  '- **Branch:** `chore/portainer-stack`',
  '- Catatan ada di note.md dan CLAUDE.md',
].join('\n')

describe('markdownToTelegramHtml', () => {
  it('converts the screenshot reply into Telegram HTML', () => {
    const html = markdownToTelegramHtml(SCREENSHOT)
    expect(html).toBe(
      [
        'Proyek <b>laya-api</b>',
        '',
        '• <b>Status:</b> active',
        '• <b>Branch:</b> <code>chore/portainer-stack</code>',
        '• Catatan ada di <code>note.md</code> dan <code>CLAUDE.md</code>',
      ].join('\n')
    )
    expect(html).not.toContain('**')
    expect(html).not.toContain('`')
    assertBalanced(html)
  })

  it('escapes < > & in text, code and link hrefs', () => {
    expect(markdownToTelegramHtml('a < b && c > d')).toBe('a &lt; b &amp;&amp; c &gt; d')
    expect(markdownToTelegramHtml('`x<y>&z`')).toBe('<code>x&lt;y&gt;&amp;z</code>')
    expect(markdownToTelegramHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(markdownToTelegramHtml('[q](https://e.x/?a=1&b=2)')).toBe('<a href="https://e.x/?a=1&amp;b=2">q</a>')
    expect(escapeTelegramHtml('"&')).toBe('&quot;&amp;')
  })

  it('renders headings, nested/ordered lists, code fences, quotes, tables', () => {
    const html = markdownToTelegramHtml(
      [
        '## Ringkasan **penting**',
        '',
        '1. satu',
        '2. dua',
        '   - anak',
        '',
        '```ts',
        'if (a < b) run()',
        '```',
        '',
        '> kutip *miring* ~~coret~~',
        '',
        '| Nama | Status |',
        '|---|---|',
        '| **api** | ok |',
        '',
        '[lokal](./a.md) ---',
      ].join('\n')
    )
    expect(html).toContain('<b>Ringkasan penting</b>')
    expect(html).toContain('1. satu\n2. dua\n  • anak')
    expect(html).toContain('<pre><code class="language-ts">if (a &lt; b) run()</code></pre>')
    expect(html).toContain('<blockquote>kutip <i>miring</i> <s>coret</s></blockquote>')
    expect(html).toContain('<pre>Nama | Status\n-----|-------\napi  | ok</pre>')
    expect(html).toContain('lokal ---') // relative href is dropped, label kept
    assertBalanced(html)
  })

  it('does not throw on unbalanced or odd markdown', () => {
    for (const odd of ['**unclosed', '`tick', '```\nno end', '[x](', '<b>raw', '* * *', '| a |\n|-', '\u0000&;', '']) {
      const html = markdownToTelegramHtml(odd)
      assertBalanced(html)
    }
    expect(markdownToTelegramHtml('**unclosed')).toBe('**unclosed')
  })
})

describe('splitTelegramHtml', () => {
  it('keeps every chunk within the limit with balanced tags', () => {
    const md = Array.from({ length: 300 }, (_, i) => `- **item ${i}** with \`code_${i}\` & text`).join('\n')
    const big = markdownToTelegramHtml(`${md}\n\n\`\`\`\n${'x < y\n'.repeat(900)}\`\`\``)
    const chunks = splitTelegramHtml(big, 4096)
    expect(chunks.length).toBeGreaterThan(2)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096)
      assertBalanced(chunk)
    }
    // Nothing is lost except whitespace at cut points.
    const strip = (s: string): string => telegramHtmlToPlain(s).replace(/\s/g, '')
    expect(chunks.map(strip).join('')).toBe(strip(big))
  })

  it('re-opens a code block that spans a cut', () => {
    const chunks = splitTelegramHtml(`<pre><code class="language-ts">${'line\n'.repeat(30)}</code></pre>`, 80)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.startsWith('<pre><code class="language-ts">')).toBe(true)
      expect(chunk.endsWith('</code></pre>')).toBe(true)
    }
  })
})

describe('sendTelegramMarkdown', () => {
  function recorder(responses: Array<{ status: number; body: unknown }>) {
    const bodies: Array<Record<string, unknown>> = []
    const fetch: TelegramSenderFetch = async (_url, init) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>)
      const next = responses.shift() ?? { status: 200, body: { ok: true, result: { message_id: 1 } } }
      return { ok: next.status < 300, status: next.status, json: async () => next.body }
    }
    return { bodies, fetch }
  }

  it('sends HTML with parse_mode and link previews disabled', async () => {
    const { bodies, fetch } = recorder([])
    const result = await sendTelegramMarkdown({ chatId: '42', text: SCREENSHOT }, { fetch, env: ENV })
    expect(result.ok).toBe(true)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]?.['parse_mode']).toBe('HTML')
    expect(bodies[0]?.['link_preview_options']).toEqual({ is_disabled: true })
    expect(bodies[0]?.['text']).toContain('<b>laya-api</b>')
  })

  it('retries a chunk as plain text after a 400 "can\'t parse entities"', async () => {
    const { bodies, fetch } = recorder([
      { status: 400, body: { ok: false, error_code: 400, description: "Bad Request: can't parse entities: unsupported start tag" } },
    ])
    const result = await sendTelegramMarkdown({ chatId: '42', text: 'a **b** & `c`' }, { fetch, env: ENV })
    expect(result.ok).toBe(true)
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toEqual({ chat_id: '42', text: 'a b & c' })
  })

  it('does not plain-retry other rejections', async () => {
    const { bodies, fetch } = recorder([{ status: 400, body: { ok: false, description: 'Bad Request: chat not found' } }])
    const result = await sendTelegramMarkdown({ chatId: '42', text: '**x**' }, { fetch, env: ENV })
    expect(result.ok).toBe(false)
    expect(bodies).toHaveLength(1)
  })

  it('sends every chunk of a long reply in order', async () => {
    const { bodies, fetch } = recorder([])
    const text = Array.from({ length: 400 }, (_, i) => `- **row ${i}** ${'z'.repeat(20)}`).join('\n')
    const result = await sendTelegramMarkdown({ chatId: '42', text }, { fetch, env: ENV })
    expect(result.ok).toBe(true)
    expect(bodies.length).toBeGreaterThan(1)
    expect(String(bodies[0]?.['text'])).toMatch(/^• <b>row 0<\/b>/)
    for (const body of bodies) expect(String(body['text']).length).toBeLessThanOrEqual(4096)
  })
})
