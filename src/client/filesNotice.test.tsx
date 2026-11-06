/** @vitest-environment jsdom */
// The Files node notice store + its footer/progress rendering: one text surface for every message.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NOTICE_INFO_MS, dismissNotice, noticesOf, notify, resetFilesNotices } from './filesNotice'
import { FilesNoticeLine, FilesProgressBar, NOTICE_TEXT } from './FilesNoticeLine'

beforeEach(() => { resetFilesNotices() })
afterEach(() => { cleanup(); vi.useRealTimers() })

const foot = () => screen.getByTestId('foot').textContent
const Foot = ({ id = 'n1' }: { id?: string }) => (
  <div data-testid="foot" role="status" aria-live="polite"><FilesProgressBar nodeId={id} /><FilesNoticeLine nodeId={id} fallback="3 of 4" /></div>
)

describe('filesNotice store', () => {
  it('upserts by id and keeps notices per node', () => {
    notify('n1', { id: 'x', kind: 'error', text: 'one' })
    notify('n1', { id: 'x', kind: 'error', text: 'two' })
    notify('n2', { kind: 'error', text: 'other node' })
    expect(noticesOf('n1').map((n) => n.text)).toEqual(['two'])
    expect(noticesOf('n2')).toHaveLength(1)
  })

  it('info dismisses itself after NOTICE_INFO_MS; error stays', () => {
    vi.useFakeTimers()
    notify('n1', { id: 'e', kind: 'error', text: 'sticky' })
    notify('n1', { id: 'i', kind: 'info', text: 'done' })
    vi.advanceTimersByTime(NOTICE_INFO_MS - 1)
    expect(noticesOf('n1').map((n) => n.id)).toEqual(['e', 'i'])
    vi.advanceTimersByTime(1)
    expect(noticesOf('n1').map((n) => n.id)).toEqual(['e'])
  })

  it('replacing an info notice with an error cancels its auto-dismiss', () => {
    vi.useFakeTimers()
    notify('n1', { id: 'u', kind: 'info', text: 'done' })
    notify('n1', { id: 'u', kind: 'error', text: 'failed' })
    vi.advanceTimersByTime(NOTICE_INFO_MS * 2)
    expect(noticesOf('n1').map((n) => n.text)).toEqual(['failed'])
  })

  it('a progress tick keeps its place, so a newer error stays the one shown', () => {
    notify('n1', { id: 'p', kind: 'progress', text: 'Uploading 1 of 2', progress: 0.1 })
    notify('n1', { id: 'e', kind: 'error', text: 'Could not copy' })
    notify('n1', { id: 'p', kind: 'progress', text: 'Uploading 2 of 2', progress: 0.6 })
    expect(noticesOf('n1').map((n) => n.id)).toEqual(['p', 'e'])
  })

  it('dismissNotice of an absent id is a no-op', () => {
    notify('n1', { id: 'a', kind: 'error', text: 'a' })
    dismissNotice('n1', 'missing')
    dismissNotice('n9', 'a')
    expect(noticesOf('n1')).toHaveLength(1)
  })
})

describe('FilesNoticeLine / FilesProgressBar', () => {
  it('shows the fallback count when there is no notice, and no progress bar', () => {
    render(<Foot />)
    expect(foot()).toBe('3 of 4')
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('error: text + Dismiss icon button that returns to the fallback', () => {
    render(<Foot />)
    act(() => { notify('n1', { id: 'e', kind: 'error', text: 'Could not reveal “a”', detail: 'why' }) })
    expect(foot()).toBe('Could not reveal “a”')
    expect(screen.getByText('Could not reveal “a”').getAttribute('title')).toBe('why')
    fireEvent.click(screen.getByRole('button', { name: NOTICE_TEXT.dismiss }))
    expect(foot()).toBe('3 of 4')
  })

  it('progress: determinate bar + Cancel that calls onCancel; no Dismiss', () => {
    const onCancel = vi.fn()
    render(<Foot />)
    act(() => { notify('n1', { id: 'p', kind: 'progress', text: 'Uploading 1 of 2 · a', progress: 0.256, onCancel }) })
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('26')
    expect(screen.queryByRole('button', { name: NOTICE_TEXT.dismiss })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: NOTICE_TEXT.cancel }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('actions render as icon buttons only (no visible text besides the message)', () => {
    const run = vi.fn()
    render(<Foot />)
    act(() => { notify('n1', { kind: 'error', text: 'failed', actions: [{ label: 'Retry', icon: 'refresh', run }] }) })
    expect(foot()).toBe('failed')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('info shows without a Dismiss button and disappears on its own', () => {
    vi.useFakeTimers()
    render(<Foot />)
    act(() => { notify('n1', { kind: 'info', text: '3 files uploaded' }) })
    expect(foot()).toBe('3 files uploaded')
    expect(screen.queryByRole('button')).toBeNull()
    act(() => { vi.advanceTimersByTime(NOTICE_INFO_MS) })
    expect(foot()).toBe('3 of 4')
  })
})
