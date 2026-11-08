/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const tok = vi.hoisted(() => ({
  // Stand-in for Monaco's tokenizer (no Worker in jsdom): every word of a line is a `keyword`.
  monacoTokenize: vi.fn(async (code: string) => code.split('\n').map((line) => [{ text: line, kind: 'keyword' }]))
}))
vi.mock('./chat/chatHighlight.monaco', () => tok)
vi.mock('./fsClient', () => ({ rawUrl: (p: string) => `/api/fs/raw?path=${encodeURIComponent(p)}` }))

import EditorMarkdownPreview from './EditorMarkdownPreview'
import { NodeActionsProvider } from './nodeActions'
import { setLspFileOpener } from './editorLsp.store'

afterEach(() => { cleanup(); tok.monacoTokenize.mockClear() })

const SKILL = '---\nname: laya\ndescription: Use when the user says hi\n---\n# Laya\n\nBody text.\n'

function mount(source: string, over: { filePath?: string; nodeId?: string } = {}) {
  const onOpenFile = vi.fn()
  const onOpenUrl = vi.fn()
  const r = render(
    <EditorMarkdownPreview source={source} filePath={over.filePath ?? '/repo/docs/SKILL.md'} nodeId={over.nodeId ?? 'n1'}
      onOpenFile={onOpenFile} onOpenUrl={onOpenUrl} />
  )
  return { ...r, onOpenFile, onOpenUrl, root: r.container.querySelector('.editor-node__md-body') as HTMLElement }
}

describe('EditorMarkdownPreview frontmatter', () => {
  it('shows flat frontmatter as a key/value table, not as a setext heading', () => {
    const { root } = mount(SKILL)
    const rows = Array.from(root.querySelectorAll('.editor-node__md-front tr')).map((tr) =>
      [tr.querySelector('th')!.textContent, tr.querySelector('td')!.textContent])
    expect(rows).toEqual([['name', 'laya'], ['description', 'Use when the user says hi']])
    expect(root.querySelector('hr')).toBeNull()
    expect(root.querySelector('h2')).toBeNull()
    expect(Array.from(root.querySelectorAll('h1')).map((h) => h.textContent)).toEqual(['Laya'])
  })

  it('shows nested frontmatter as a highlighted YAML block', async () => {
    const { root } = mount('---\nname: x\ntags:\n  - a\n---\nBody')
    const code = root.querySelector('.editor-node__md-front pre > code.language-yaml')!
    expect(code.textContent).toBe('name: x\ntags:\n  - a')
    expect(root.querySelector('.editor-node__md-front table')).toBeNull()
    await waitFor(() => expect(code.querySelector('.chat-tok--keyword')).not.toBeNull())
  })
})

describe('EditorMarkdownPreview body', () => {
  it('decorates and highlights code blocks with the chat pipeline', async () => {
    const { root } = mount('```ts\nconst a = 1\n```\n')
    expect(root.querySelector('.chat-code .chat-code__copy')).not.toBeNull()
    await waitFor(() => expect(root.querySelector('pre code .chat-tok--keyword')?.textContent).toBe('const a = 1'))
    expect(tok.monacoTokenize).toHaveBeenCalledWith('const a = 1', 'ts')
  })

  it('serves relative images from the file folder; absolute and data: URLs stay', () => {
    const { root } = mount('![a](img/a.png) ![b](../b%20c.png?v=1) ![c](https://x.test/c.png) ![d](/abs/d.png)')
    expect(Array.from(root.querySelectorAll('img')).map((i) => i.getAttribute('src'))).toEqual([
      `/api/fs/raw?path=${encodeURIComponent('/repo/docs/img/a.png')}`,
      `/api/fs/raw?path=${encodeURIComponent('/repo/b c.png')}`,
      'https://x.test/c.png',
      `/api/fs/raw?path=${encodeURIComponent('/abs/d.png')}`
    ])
  })

  it('heading ids are user-content-* so #anchors work', () => {
    const { root } = mount('## Getting Started')
    expect(root.querySelector('h2')!.id).toBe('user-content-getting-started')
  })
})

describe('EditorMarkdownPreview links', () => {
  const MD = '[web](https://x.test/a) [doc](../README.md) [line](src/a.ts:12) [mail](mailto:a@b.c) [jump](#getting-started)\n\n## Getting Started'

  it('a web link opens via onOpenUrl and the window does not navigate', () => {
    const { root, onOpenUrl } = mount(MD)
    const a = root.querySelector('a[href^="https"]')!
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    a.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(onOpenUrl).toHaveBeenCalledWith('https://x.test/a')
  })

  it('a middle click is guarded too', () => {
    const { root, onOpenFile } = mount(MD)
    const ev = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
    root.querySelector('a[href="../README.md"]')!.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(onOpenFile).toHaveBeenCalledWith('/repo/README.md', undefined, undefined)
  })

  it('local links resolve against the file folder, with :line', () => {
    const { root, onOpenFile } = mount(MD)
    fireEvent.click(root.querySelector('a[href="src/a.ts:12"]')!)
    expect(onOpenFile).toHaveBeenCalledWith('/repo/docs/src/a.ts', 12, undefined)
  })

  it('mailto is left to the browser; nothing is opened', () => {
    const { root, onOpenFile, onOpenUrl } = mount(MD)
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    root.querySelector('a[href^="mailto"]')!.dispatchEvent(ev)
    expect(onOpenUrl).not.toHaveBeenCalled()
    expect(onOpenFile).not.toHaveBeenCalled()
  })

  it('#anchor scrolls to the heading inside the preview', () => {
    const { root } = mount(MD)
    const h = root.querySelector('h2')!
    const scrollIntoView = vi.fn()
    h.scrollIntoView = scrollIntoView
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    root.querySelector('a[href="#getting-started"]')!.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
  })

  it('defaults: web → openBrowserAt anchored to the node, local → app file opener', () => {
    const openBrowserAt = vi.fn(() => ({ status: 'created' as const, nodeId: 'b1' }))
    const opener = vi.fn()
    const off = setLspFileOpener(opener)
    const { container } = render(
      <NodeActionsProvider value={{ onSession: () => {}, onToggleHideLinks: () => {}, openBrowserAt }}>
        <EditorMarkdownPreview source="[w](https://x.test/) [f](b.md)" filePath="/repo/a.md" nodeId="n7" />
      </NodeActionsProvider>
    )
    fireEvent.click(container.querySelector('a[href^="https"]')!)
    fireEvent.click(container.querySelector('a[href="b.md"]')!)
    expect(openBrowserAt).toHaveBeenCalledWith({ url: 'https://x.test/', anchorNodeId: 'n7' })
    expect(opener).toHaveBeenCalledWith('/repo/b.md', 0, 0)
    off()
  })
})

describe('EditorMarkdownPreview scroll', () => {
  it('keeps the scroll position across unmount/remount (⌘M toggle)', () => {
    const first = mount('# a', { nodeId: 'scroll-node' })
    first.root.scrollTop = 240
    fireEvent.scroll(first.root)
    first.unmount()
    const again = mount('# a', { nodeId: 'scroll-node' })
    expect(again.root.scrollTop).toBe(240)
    expect(mount('# a', { nodeId: 'other-node' }).root.scrollTop).toBe(0)
  })
})
