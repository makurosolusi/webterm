/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CANVAS_LINK_NOTICE_KEY, CANVAS_LINK_TEXT, openInSystemBrowser, openLinkInCanvas, webUrl } from './canvasLinks'
import * as notice from './workspaceSave.notice'

afterEach(() => { vi.restoreAllMocks() })

describe('webUrl', () => {
  it('accepts http(s) only', () => {
    expect(webUrl('https://a.test/x')).toBe('https://a.test/x')
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'mailto:a@b.c', 'not a url', '/relative']) expect(webUrl(bad)).toBeNull()
  })
})

describe('openLinkInCanvas', () => {
  it('opens in the browser node, anchored, without a window', () => {
    const win = vi.spyOn(window, 'open').mockReturnValue(null)
    const open = vi.fn(() => ({ status: 'created' }))
    expect(openLinkInCanvas('https://a.test/', { openBrowserAt: open, anchorNodeId: 'n1' })).toBe('canvas')
    expect(open).toHaveBeenCalledWith({ url: 'https://a.test/', anchorNodeId: 'n1' })
    expect(win).not.toHaveBeenCalled()
  })

  it('blocked: shows a notice with the explicit exit and opens nothing by itself', () => {
    const win = vi.spyOn(window, 'open').mockReturnValue(null)
    const show = vi.spyOn(notice, 'showNotice').mockImplementation(() => undefined)
    vi.spyOn(notice, 'closeNotice').mockImplementation(() => undefined)
    expect(openLinkInCanvas('https://a.test/')).toBe('blocked')
    expect(openLinkInCanvas('https://b.test/', { openBrowserAt: () => ({ status: 'invalid' }) })).toBe('blocked')
    expect(win).not.toHaveBeenCalled()
    const [key, n] = show.mock.calls[0]
    expect(key).toBe(CANVAS_LINK_NOTICE_KEY)
    expect(n.actions?.map((a) => a.label)).toEqual([CANVAS_LINK_TEXT.openSystem, CANVAS_LINK_TEXT.copy])
    n.actions?.[0].onClick() // the user's explicit click is the consent
    expect(win).toHaveBeenCalledExactlyOnceWith('https://a.test/', '_blank', 'noopener,noreferrer')
  })

  it('refuses non-web schemes without opening anything', () => {
    const win = vi.spyOn(window, 'open').mockReturnValue(null)
    const show = vi.spyOn(notice, 'showNotice').mockImplementation(() => undefined)
    const open = vi.fn(() => ({ status: 'created' }))
    expect(openLinkInCanvas('javascript:alert(1)', { openBrowserAt: open })).toBe('invalid')
    expect(open).not.toHaveBeenCalled()
    expect(win).not.toHaveBeenCalled()
    expect(show).toHaveBeenCalledOnce()
  })
})

describe('openInSystemBrowser', () => {
  it('opens a web URL, refuses others', () => {
    const win = vi.spyOn(window, 'open').mockReturnValue(null)
    openInSystemBrowser('file:///tmp/x.html')
    expect(win).not.toHaveBeenCalled()
    openInSystemBrowser('https://a.test/')
    expect(win).toHaveBeenCalledOnce()
  })
})
