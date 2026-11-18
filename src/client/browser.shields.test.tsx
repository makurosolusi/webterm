/** @vitest-environment jsdom */
// Pesan tab dari server -> callback tab (popup lama diabaikan); chip Shields: hitungan, tooltip, sakelar per situs.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserState } from '../shared/browser.contract'
import type { BrowserListener, BrowserStream } from './browser.stream'
import { useBrowserSession } from './browser.useSession'
import BrowserShieldsChip from './BrowserShieldsChip'
import { TooltipProvider } from '@/components/ui/tooltip'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const state = (over: Partial<BrowserState> = {}): BrowserState => ({
  id: 'b1', url: 'https://games.test/play', title: '', loading: false, canBack: false, canForward: false, lease: 'human', live: 'live', ...over,
})

describe('useBrowserSession popup', () => {
  it('ignores a legacy popup message (popups are tabs now) and hands tab messages to onTabMsg', () => {
    let listener: BrowserListener | null = null
    const stream: BrowserStream = {
      subscribe: (_id, l) => { listener = l; return () => undefined },
      attach: () => undefined, resize: () => undefined, detach: () => undefined, send: () => undefined, reset: () => undefined,
    }
    const onTabMsg = vi.fn()
    function Probe() { useBrowserSession('b1', true, stream, onTabMsg); return null }
    render(<Probe />)
    act(() => listener?.onMsg({ t: 'popup', id: 'b1', url: 'https://news.test/a' }))
    expect(onTabMsg).not.toHaveBeenCalled()
    const notice = { t: 'tabNotice' as const, id: 'b1', message: 'Tab limit (8) reached' }
    act(() => listener?.onMsg(notice))
    expect(onTabMsg).toHaveBeenCalledWith(notice)
  })
})

describe('BrowserShieldsChip', () => {
  const chip = (s: BrowserState, onToggle = vi.fn()) => {
    render(<TooltipProvider><BrowserShieldsChip state={s} onToggle={onToggle} /></TooltipProvider>)
    return onToggle
  }

  it('is hidden when the server runs no blocker', () => {
    chip(state())
    expect(screen.queryByRole('button', { name: 'Shields' })).toBeNull()
  })

  it('shows the blocked total and turns Shields off for the site on click', () => {
    const onToggle = chip(state({ shieldsOff: false, blockedAds: 12, blockedPopups: 2 }))
    const btn = screen.getByRole('button', { name: 'Shields' })
    expect(btn.textContent).toContain('14')
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(btn)
    expect(onToggle).toHaveBeenCalledWith(false)
  })

  it('when off for the site, clicking turns it back on', () => {
    const onToggle = chip(state({ shieldsOff: true, blockedAds: 0, blockedPopups: 0 }))
    const btn = screen.getByRole('button', { name: 'Shields' })
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(btn)
    expect(onToggle).toHaveBeenCalledWith(true)
  })
})
