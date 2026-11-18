/** @vitest-environment jsdom */
// Two quick tab clicks: the slow answer to the first must not flip the view back to the first tab.
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeState } from './browserTabsHarness'

const h = vi.hoisted(() => ({ activate: vi.fn(), notice: vi.fn() }))
vi.mock('./browserTabs.api', () => ({ tabsApi: { activate: h.activate } }))
vi.mock('../workspaceSave.notice', () => ({ showNotice: h.notice, closeNotice: vi.fn() }))

import { useBrowserTabs } from './useBrowserTabs'

describe('activate under quick clicks', () => {
  it('a stale answer does not undo the newer click', async () => {
    const answers: Array<(v: unknown) => void> = []
    h.activate.mockImplementation((_n: string, tabId: string) => new Promise((res) => { answers.push(() => res({ state: makeState(['a', 'b', 'c'], { activeTabId: tabId }) })) }))
    const { result } = renderHook(() => useBrowserTabs('n1', undefined, () => undefined))
    act(() => result.current.onMsg({ t: 'tabs', id: 'n1', state: makeState(['a', 'b', 'c']) }))
    act(() => result.current.act({ type: 'activate', tabId: 'b' }))
    act(() => result.current.act({ type: 'activate', tabId: 'c' }))
    expect(result.current.view.activeTabId).toBe('c')
    await act(async () => { answers[0](null); await Promise.resolve() }) // the answer for 'b' arrives last-but-one
    expect(result.current.view.activeTabId).toBe('c')
    await act(async () => { answers[1](null); await Promise.resolve() })
    expect(result.current.view.activeTabId).toBe('c')
  })

  describe('a failing activate (server 500)', () => {
    const boot = () => {
      const r = renderHook(() => useBrowserTabs('n1', undefined, () => undefined))
      act(() => r.result.current.onMsg({ t: 'tabs', id: 'n1', state: makeState(['a', 'b']) }))
      return r.result
    }
    afterEach(() => { vi.useRealTimers(); h.activate.mockReset(); h.notice.mockReset() })

    it('one click shows the tab at once, retries once and says nothing when the retry works', async () => {
      vi.useFakeTimers()
      h.activate.mockRejectedValueOnce(new Error('Screencast is already active')).mockResolvedValueOnce({ state: makeState(['a', 'b'], { activeTabId: 'b' }) })
      const result = boot()
      act(() => result.current.act({ type: 'activate', tabId: 'b' }))
      expect(result.current.view.activeTabId).toBe('b')
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      expect(h.activate).toHaveBeenCalledTimes(2)
      expect(result.current.view.activeTabId).toBe('b')
      expect(h.notice).not.toHaveBeenCalled()
    })

    it('a persistent failure keeps the choice on screen and reports it once', async () => {
      vi.useFakeTimers()
      h.activate.mockRejectedValue(new Error('Screencast is already active'))
      const result = boot()
      act(() => result.current.act({ type: 'activate', tabId: 'b' }))
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      expect(h.activate).toHaveBeenCalledTimes(2)
      expect(result.current.view.activeTabId).toBe('b')
      expect(h.notice).toHaveBeenCalledTimes(1)
    })
  })
})
