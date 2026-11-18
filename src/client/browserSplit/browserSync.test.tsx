/** @vitest-environment jsdom */
// Sync control of a split browser node: the message fold, the one-time warning, the indicator with its Stop button
// (mouse, keyboard, ARIA) and the per-pane "no match" mark.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../vscode/test-setup'
import { BrowserSyncMiss } from './BrowserSyncMiss'
import { BrowserSyncToggle } from './BrowserSyncToggle'
import { MISS_TTL_MS, SYNC_OFF, SYNC_WARNING, activeMiss, applySyncMsg, isSyncMsg, resetSyncWarned } from './browserSync'
import type { SyncView } from './browserSync'

const fetchMock = vi.fn()
beforeEach(() => {
  resetSyncWarned()
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ on: true }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })
const ON: SyncView = { on: true, miss: {} }
const lastBody = () => JSON.parse(String((fetchMock.mock.calls.at(-1)?.[1] as { body: string }).body))

describe('sync view', () => {
  it('folds sync on/off and marks panes; off forgets the marks', () => {
    expect(isSyncMsg({ t: 'sync', id: 'n', on: true })).toBe(true)
    expect(isSyncMsg({ t: 'tabNotice', id: 'n', message: 'x' })).toBe(false)
    const on = applySyncMsg(SYNC_OFF, { t: 'sync', id: 'n', on: true }, 1)
    const missed = applySyncMsg(on, { t: 'syncMiss', id: 'n', tab: 't2', reason: 'no_match' }, 10)
    expect(missed).toEqual({ on: true, miss: { t2: { reason: 'no_match', at: 10 } } })
    expect(applySyncMsg(missed, { t: 'sync', id: 'n', on: false }, 20)).toBe(SYNC_OFF)
  })
  it('a mark is fresh for a few seconds only', () => {
    const v = applySyncMsg(ON, { t: 'syncMiss', id: 'n', tab: 't2', reason: 'no_match' }, 100)
    expect(activeMiss(v, 't2', 100 + MISS_TTL_MS - 1)).toBeDefined()
    expect(activeMiss(v, 't2', 100 + MISS_TTL_MS)).toBeUndefined()
    expect(activeMiss(v, 't3', 100)).toBeUndefined()
  })
})

describe('BrowserSyncToggle', () => {
  it('is disabled with one pane and says why', () => {
    render(<BrowserSyncToggle nodeId="n1" sync={SYNC_OFF} panes={1} />)
    const b = screen.getByRole('button', { name: 'Sync panes' })
    expect((b as HTMLButtonElement).disabled).toBe(true)
    expect(b.getAttribute('aria-pressed')).toBe('false')
  })

  it('warns once before the first turn-on; confirming sends {on:true}; the next time it goes straight through', async () => {
    const { rerender } = render(<BrowserSyncToggle nodeId="n1" sync={SYNC_OFF} panes={2} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sync panes' }))
    expect(await screen.findByText(SYNC_WARNING)).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Turn on sync'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/browser/n1/sync')
    expect(lastBody()).toEqual({ on: true })
    rerender(<BrowserSyncToggle nodeId="n1" sync={SYNC_OFF} panes={2} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sync panes' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(screen.queryByText(SYNC_WARNING)).toBeNull()
  })

  it('Cancel in the warning sends nothing', async () => {
    render(<BrowserSyncToggle nodeId="n1" sync={SYNC_OFF} panes={2} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sync panes' }))
    fireEvent.click(await screen.findByText('Cancel'))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('when on: a visible "Sync on" indicator, announced, with a Stop button that sends {on:false}', async () => {
    render(<BrowserSyncToggle nodeId="n1" sync={ON} panes={2} />)
    expect(screen.getByRole('group', { name: 'Sync is on' })).toBeTruthy()
    expect(screen.getByText('Sync on', { selector: '.bsync-pill' })).toBeTruthy()
    expect((screen.getByRole('status')).textContent).toContain('Sync on')
    fireEvent.click(screen.getByRole('button', { name: 'Stop sync' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(lastBody()).toEqual({ on: false })
  })

  it('Escape inside the indicator stops sync (keyboard)', async () => {
    render(<BrowserSyncToggle nodeId="n1" sync={ON} panes={2} />)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Stop sync' }), { key: 'Escape' })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(lastBody()).toEqual({ on: false })
  })

  it('a refused request shows the reason as an alert and keeps the state the server reports', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'bad_request' }), { status: 400 }))
    render(<BrowserSyncToggle nodeId="n1" sync={ON} panes={2} />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop sync' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Could not stop sync (bad_request)')
    expect(screen.getByText('Sync on', { selector: '.bsync-pill' })).toBeTruthy()
  })
})

describe('BrowserSyncMiss', () => {
  it('shows "No match" on the pane that missed, not on the others, and only while sync is on', () => {
    const v = applySyncMsg(ON, { t: 'syncMiss', id: 'n', tab: 't2', reason: 'no_match' }, Date.now())
    const { rerender } = render(<BrowserSyncMiss sync={v} tabId="t2" />)
    expect((screen.getByRole('status')).textContent).toContain('No match')
    rerender(<BrowserSyncMiss sync={v} tabId="t3" />)
    expect(screen.queryByRole('status')).toBeNull()
    rerender(<BrowserSyncMiss sync={{ ...v, on: false }} tabId="t2" />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('goes away by itself after the time to live', () => {
    vi.useFakeTimers()
    const v = applySyncMsg(ON, { t: 'syncMiss', id: 'n', tab: 't2', reason: 'cross_origin' }, Date.now())
    render(<BrowserSyncMiss sync={v} tabId="t2" />)
    expect((screen.getByRole('status')).textContent).toContain('Skipped: submits elsewhere')
    act(() => { vi.advanceTimersByTime(MISS_TTL_MS + 50) })
    expect(screen.queryByRole('status')).toBeNull()
  })
})
