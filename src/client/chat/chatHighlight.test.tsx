/** @vitest-environment jsdom */
import { cleanup, render, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { highlightCodeBlocks, tokenKind, type Tokenize } from './chatHighlight'

// test-only: a word tokenizer standing in for Monaco (jsdom cannot run it).
const words: Tokenize = async (code, lang) => lang === 'nope' ? null : code.split('\n').map((line) =>
  line.split(/(\s+)/).filter(Boolean).map((w) => (w === 'const' ? { text: w, kind: 'keyword' } : w.startsWith('"') ? { text: w, kind: 'string' } : { text: w })))

vi.mock('./chatHighlight.monaco', () => ({ monacoTokenize: (code: string, lang: string) => words(code, lang) }))
const { default: ChatMarkdown } = await import('./chatMarkdown')

afterEach(cleanup)

function block(lang: string, text: string): HTMLElement {
  const root = document.createElement('div')
  const pre = document.createElement('pre')
  const code = document.createElement('code')
  if (lang) code.className = `language-${lang}`
  code.textContent = text
  pre.append(code)
  root.append(pre)
  document.body.append(root)
  return root
}

describe('highlightCodeBlocks', () => {
  it('maps Monarch token types to color kinds', () => {
    expect(tokenKind('keyword.ts')).toBe('keyword')
    expect(tokenKind('string.key.json')).toBe('string')
    expect(tokenKind('identifier.ts')).toBeUndefined()
    expect(tokenKind('')).toBeUndefined()
  })

  it('colors every TypeScript family Monaco emits (types recorded from its Monarch grammar)', () => {
    // `const answer: number = 42 // c` in the real preview: const/number → keyword.ts, 42 → number.ts.
    expect(tokenKind('keyword.ts')).toBe('keyword')
    expect(tokenKind('number.ts')).toBe('number')
    expect(tokenKind('number.float.ts')).toBe('number')
    expect(tokenKind('number.hex.ts')).toBe('number')
    expect(tokenKind('comment.ts')).toBe('comment')
    expect(tokenKind('comment.doc.ts')).toBe('comment')
    expect(tokenKind('type.identifier.ts')).toBe('type')
    expect(tokenKind('string.ts')).toBe('string')
    expect(tokenKind('regexp.ts')).toBe('regexp')
    expect(tokenKind('delimiter.ts')).toBeUndefined()
  })

  it('the color variables exist on every surface that highlights (chat and the editor preview)', () => {
    // The kinds are colored through CSS variables: a surface missing here renders tokens uncolored.
    const css = readFileSync(join(__dirname, 'chatHighlight.css'), 'utf8')
    for (const surface of ['.chat-markdown', '.editor-node__md-body']) {
      expect(css).toMatch(new RegExp(`(^|[,\\s])${surface.replace('.', '\\.')}[^{]*\\{[^}]*--chat-tok-keyword`, 'm'))
      expect(css).toMatch(new RegExp(`:root\\[data-theme='light'\\] ${surface.replace('.', '\\.')}[^{]*\\{[^}]*--chat-tok-keyword`))
    }
  })

  it('wraps tokens in classed spans and keeps the text (and Copy) exactly the same', async () => {
    const root = block('ts', 'const a = "x"\nlet b\n')
    await highlightCodeBlocks(root, words)
    const code = root.querySelector('code') as HTMLElement
    expect(code.textContent).toBe('const a = "x"\nlet b\n')
    expect(code.querySelector('.chat-tok--keyword')?.textContent).toBe('const')
    expect(code.querySelector('.chat-tok--string')?.textContent).toBe('"x"')
    expect(code.hasAttribute('data-highlighted')).toBe(true)
  })

  it('markup inside the code stays text: no element is ever created from it', async () => {
    const root = block('html', 'const <img src=x onerror="alert(1)"> <script>alert(2)</script>')
    await highlightCodeBlocks(root, words)
    expect(root.querySelector('img, script')).toBeNull()
    expect(root.querySelector('code')?.textContent).toContain('<img src=x onerror="alert(1)">')
    expect(Array.from(root.querySelectorAll('code *')).every((el) => el.tagName === 'SPAN' && el.attributes.length === 1)).toBe(true)
  })

  it('leaves blocks plain without a language, for an unknown one, and when the text changed meanwhile', async () => {
    const plain = block('', 'const a')
    await highlightCodeBlocks(plain, words)
    expect(plain.querySelector('span')).toBeNull()
    const unknown = block('nope', 'const a')
    await highlightCodeBlocks(unknown, words)
    expect(unknown.querySelector('span')).toBeNull()
    const stale = block('ts', 'const a')
    await highlightCodeBlocks(stale, async (code, lang) => { (stale.querySelector('code') as HTMLElement).textContent = 'changed'; return words(code, lang) })
    expect(stale.querySelector('span')).toBeNull()
  })
})

describe('ChatMarkdown highlighting', () => {
  it('colors a fenced block after the sanitizer ran; script in the Markdown is still removed', async () => {
    const { container } = render(<ChatMarkdown source={'<script>window.x=1</script>\n\n```ts\nconst a = "b"\n```'} />)
    await waitFor(() => expect(container.querySelector('.chat-tok--keyword')?.textContent).toBe('const'))
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('.chat-code__lang')?.textContent).toBe('ts')
  })
})
