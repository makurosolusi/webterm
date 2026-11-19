/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest'
import { decideMarkdownLinkClick, handleMarkdownLinkEvent, openWebLink, resolvePath } from './markdownLinks'

describe('decideMarkdownLinkClick: absolute URLs', () => {
  it('sends web links out, normalised and trimmed', () => {
    expect(decideMarkdownLinkClick('https://docs.test/my page')).toEqual({ action: 'external', url: 'https://docs.test/my%20page' })
    expect(decideMarkdownLinkClick('  http://host.test  ')).toEqual({ action: 'external', url: 'http://host.test/' })
  })

  it('leaves mailto and tel to the browser', () => {
    expect(decideMarkdownLinkClick('mailto:team@mail.test')).toEqual({ action: 'native' })
    expect(decideMarkdownLinkClick('tel:+15550100')).toEqual({ action: 'native' })
  })

  it('ignores unknown schemes, blank hrefs and protocol-relative URLs', () => {
    for (const href of ['ftp://files.test/a', 'javascript:alert(1)', 'vscode://file/x', '', '   ', '//cdn.test/lib.js']) {
      expect(decideMarkdownLinkClick(href, '/repo'), href).toEqual({ action: 'ignore' })
    }
  })

  it('opens file: URLs as local paths', () => {
    expect(decideMarkdownLinkClick('file:///var/tmp/note.md')).toEqual({ action: 'local', path: '/var/tmp/note.md' })
  })
})

describe('decideMarkdownLinkClick: fragments', () => {
  it('scrolls to a decoded in-page anchor', () => {
    expect(decideMarkdownLinkClick('#getting%20started')).toEqual({ action: 'anchor', id: 'getting started' })
    expect(decideMarkdownLinkClick('#%E0%A4%A')).toEqual({ action: 'anchor', id: '%E0%A4%A' })
  })

  it('ignores a bare #', () => {
    expect(decideMarkdownLinkClick('#')).toEqual({ action: 'ignore' })
  })
})

describe('decideMarkdownLinkClick: local files', () => {
  it('resolves relative paths against the markdown folder and drops query and fragment', () => {
    expect(decideMarkdownLinkClick('guide/setup.md#step-2', '/proj')).toEqual({ action: 'local', path: '/proj/guide/setup.md' })
    expect(decideMarkdownLinkClick('../a%20b.md?v=3', '/proj/guide')).toEqual({ action: 'local', path: '/proj/a b.md' })
  })

  it('keeps absolute paths as they are', () => {
    expect(decideMarkdownLinkClick('/opt/conf.yml', '/proj')).toEqual({ action: 'local', path: '/opt/conf.yml' })
  })

  it('reads :line and :line:column suffixes', () => {
    expect(decideMarkdownLinkClick('./lib/io.ts:120', '/proj')).toEqual({ action: 'local', path: '/proj/lib/io.ts', line: 120 })
    expect(decideMarkdownLinkClick('lib/io.ts:7:15', '/proj')).toEqual({ action: 'local', path: '/proj/lib/io.ts', line: 7, column: 15 })
  })

  it('cannot open a relative path when the folder is unknown, but still opens absolute ones', () => {
    expect(decideMarkdownLinkClick('lib/io.ts')).toEqual({ action: 'ignore' })
    expect(decideMarkdownLinkClick('/opt/run.sh:3')).toEqual({ action: 'local', path: '/opt/run.sh', line: 3 })
  })
})

describe('resolvePath', () => {
  it('folds dot segments and never climbs above the root', () => {
    expect(resolvePath('/a/b', '../../../x/./y')).toBe('/x/y')
    expect(resolvePath('/a', 'b//c')).toBe('/a/b/c')
  })

  it('ignores the folder for an absolute target', () => {
    expect(resolvePath('/a/b', '/z/q')).toBe('/z/q')
  })
})

function click(href: string, opts: { button?: number; prevented?: boolean } = {}) {
  const host = document.createElement('div')
  host.innerHTML = `<p><a href="${href}"><em>text</em></a></p>`
  const event = {
    target: host.querySelector('em'),
    button: opts.button ?? 0,
    defaultPrevented: opts.prevented ?? false,
    preventDefault: vi.fn(),
  }
  const deps = { openUrl: vi.fn(), openFile: vi.fn(), scrollToAnchor: vi.fn() }
  handleMarkdownLinkEvent(event, '/proj', deps)
  return { event, deps }
}

describe('handleMarkdownLinkEvent', () => {
  it.each([0, 1])('routes a web link on button %i and stops the browser navigating', (button) => {
    const { event, deps } = click('https://site.test', { button })
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(deps.openUrl).toHaveBeenCalledWith('https://site.test/')
  })

  it('routes a local link to openFile with its position', () => {
    const { event, deps } = click('src/main.ts:9:2', { button: 1 })
    expect(event.preventDefault).toHaveBeenCalled()
    expect(deps.openFile).toHaveBeenCalledWith('/proj/src/main.ts', 9, 2)
  })

  it('routes an anchor to scrollToAnchor', () => {
    expect(click('#top').deps.scrollToAnchor).toHaveBeenCalledWith('top')
  })

  it('does nothing for a right click or an event someone already handled', () => {
    const right = click('https://site.test', { button: 2 })
    expect(right.event.preventDefault).not.toHaveBeenCalled()
    expect(right.deps.openUrl).not.toHaveBeenCalled()
    expect(click('https://site.test', { prevented: true }).deps.openUrl).not.toHaveBeenCalled()
  })

  it('lets mailto links through to the browser', () => {
    const { event, deps } = click('mailto:me@mail.test')
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(deps.openUrl).not.toHaveBeenCalled()
  })

  it('ignores a click that is not inside a link, and tolerates a missing scroll handler', () => {
    const plain = { target: document.createElement('p'), button: 0, defaultPrevented: false, preventDefault: vi.fn() }
    handleMarkdownLinkEvent(plain, '/proj', { openUrl: vi.fn(), openFile: vi.fn() })
    expect(plain.preventDefault).not.toHaveBeenCalled()

    const host = document.createElement('div')
    host.innerHTML = '<a href="#x">x</a>'
    const anchorClick = { target: host.querySelector('a'), button: 0, defaultPrevented: false, preventDefault: vi.fn() }
    expect(() => handleMarkdownLinkEvent(anchorClick, '/proj', { openUrl: vi.fn(), openFile: vi.fn() })).not.toThrow()
  })
})

describe('openWebLink', () => {
  it('opens in the browser node, anchored to the source node', () => {
    const openBrowser = vi.fn(() => ({ status: 'created' }))
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null)
    openWebLink(openBrowser, 'https://site.test/', 'node-7')
    expect(openBrowser).toHaveBeenCalledWith({ url: 'https://site.test/', anchorNodeId: 'node-7' })
    expect(windowOpen).not.toHaveBeenCalled()
    windowOpen.mockRestore()
  })

  it('never opens a tab itself when there is no browser node or it rejects the URL', () => {
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null)
    openWebLink(undefined, 'https://one.test/')
    openWebLink(() => ({ status: 'invalid' }), 'https://two.test/')
    expect(windowOpen).not.toHaveBeenCalled()
    windowOpen.mockRestore()
  })
})
