/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest'
import { decideMarkdownLinkClick, handleMarkdownLinkEvent, openWebLink, resolvePath } from './markdownLinks'

describe('decideMarkdownLinkClick', () => {
  it('web links are external, normalized', () => {
    expect(decideMarkdownLinkClick('https://example.com/a b')).toEqual({ action: 'external', url: 'https://example.com/a%20b' })
    expect(decideMarkdownLinkClick('  http://x.test  ')).toEqual({ action: 'external', url: 'http://x.test/' })
  })

  it('mailto/tel keep the browser default; other schemes and empty hrefs are ignored', () => {
    expect(decideMarkdownLinkClick('mailto:a@b.c')).toEqual({ action: 'native' })
    expect(decideMarkdownLinkClick('tel:123')).toEqual({ action: 'native' })
    expect(decideMarkdownLinkClick('vscode://file/x')).toEqual({ action: 'ignore' })
    expect(decideMarkdownLinkClick('')).toEqual({ action: 'ignore' })
    expect(decideMarkdownLinkClick('#')).toEqual({ action: 'ignore' })
    expect(decideMarkdownLinkClick('//cdn.test/x', '/repo')).toEqual({ action: 'ignore' })
  })

  it('#fragment is an in-preview anchor (decoded)', () => {
    expect(decideMarkdownLinkClick('#set%20up')).toEqual({ action: 'anchor', id: 'set up' })
  })

  it('relative paths resolve against the markdown file folder; query/fragment dropped', () => {
    expect(decideMarkdownLinkClick('docs/a.md#intro', '/repo')).toEqual({ action: 'local', path: '/repo/docs/a.md' })
    expect(decideMarkdownLinkClick('../b%20c.md?x=1', '/repo/docs')).toEqual({ action: 'local', path: '/repo/b c.md' })
    expect(decideMarkdownLinkClick('./src/pty.ts:41:3', '/repo')).toEqual({ action: 'local', path: '/repo/src/pty.ts', line: 41, column: 3 })
    expect(decideMarkdownLinkClick('/etc/hosts', '/repo')).toEqual({ action: 'local', path: '/etc/hosts' })
    expect(decideMarkdownLinkClick('file:///tmp/x.md')).toEqual({ action: 'local', path: '/tmp/x.md' })
  })

  it('without a folder (chat) a relative path cannot be opened', () => {
    expect(decideMarkdownLinkClick('src/a.ts')).toEqual({ action: 'ignore' })
    expect(decideMarkdownLinkClick('/abs/a.ts:9')).toEqual({ action: 'local', path: '/abs/a.ts', line: 9, column: undefined })
  })

  it('resolvePath folds . and .. and never climbs above /', () => {
    expect(resolvePath('/a/b', '../../../c/./d')).toBe('/c/d')
  })
})

function clickOn(href: string, button = 0, prevented = false) {
  const host = document.createElement('div')
  host.innerHTML = `<p><a href="${href}"><span>link</span></a></p>`
  const e = { target: host.querySelector('span'), button, defaultPrevented: prevented, preventDefault: vi.fn() }
  const deps = { openUrl: vi.fn(), openFile: vi.fn(), scrollToAnchor: vi.fn() }
  handleMarkdownLinkEvent(e, '/repo', deps)
  return { e, deps }
}

describe('handleMarkdownLinkEvent', () => {
  it('primary and middle click are both kept off the tab and routed', () => {
    for (const button of [0, 1]) {
      const { e, deps } = clickOn('https://x.test', button)
      expect(e.preventDefault).toHaveBeenCalled()
      expect(deps.openUrl).toHaveBeenCalledWith('https://x.test/')
    }
    const local = clickOn('a.md', 1)
    expect(local.e.preventDefault).toHaveBeenCalled()
    expect(local.deps.openFile).toHaveBeenCalledWith('/repo/a.md', undefined, undefined)
    expect(clickOn('#intro').deps.scrollToAnchor).toHaveBeenCalledWith('intro')
  })

  it('right click, already-handled clicks, mailto and non-links are left alone', () => {
    expect(clickOn('https://x.test', 2).e.preventDefault).not.toHaveBeenCalled()
    expect(clickOn('https://x.test', 0, true).deps.openUrl).not.toHaveBeenCalled()
    const mail = clickOn('mailto:a@b.c')
    expect(mail.e.preventDefault).not.toHaveBeenCalled()
    expect(mail.deps.openUrl).not.toHaveBeenCalled()
    const e = { target: document.createElement('p'), button: 0, defaultPrevented: false, preventDefault: vi.fn() }
    handleMarkdownLinkEvent(e, '/repo', { openUrl: vi.fn(), openFile: vi.fn() })
    expect(e.preventDefault).not.toHaveBeenCalled()
  })
})

describe('openWebLink', () => {
  it('uses the browser node, anchored to the source node', () => {
    const open = vi.fn(() => ({ status: 'created' }))
    const win = vi.spyOn(window, 'open').mockImplementation(() => null)
    openWebLink(open, 'https://x.test/', 'n1')
    expect(open).toHaveBeenCalledWith({ url: 'https://x.test/', anchorNodeId: 'n1' })
    expect(win).not.toHaveBeenCalled()
    win.mockRestore()
  })

  it('falls back to a noopener tab when the browser node is off or refuses the URL', () => {
    const win = vi.spyOn(window, 'open').mockImplementation(() => null)
    openWebLink(undefined, 'https://x.test/')
    openWebLink(() => ({ status: 'invalid' }), 'https://y.test/')
    expect(win.mock.calls).toEqual([
      ['https://x.test/', '_blank', 'noopener,noreferrer'],
      ['https://y.test/', '_blank', 'noopener,noreferrer']
    ])
    win.mockRestore()
  })
})
