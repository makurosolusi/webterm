/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalChallenge, InboxClient } from './inboxApi'
import { APPROVAL_ITEM, NOW, makeClient, renderPanel } from './InboxPanel.fixtures'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('expiry countdown', () => {
  it('ticks down and expires the challenge', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const client = makeClient({ listInbox: vi.fn(async () => [APPROVAL_ITEM]) })
    renderPanel(client, { now: Date.now })

    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: 'Review Approve deploy' }))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByRole('alertdialog')).toBeDefined()
    expect(screen.getByText('expires in 2:00')).toBeDefined()

    act(() => vi.advanceTimersByTime(30_000))
    expect(screen.getByText('expires in 1:30')).toBeDefined()

    act(() => vi.advanceTimersByTime(90_000))
    expect(screen.getByText('expired')).toBeDefined()
    expect(screen.getByRole('alert').textContent).toMatch(/expired/i)
    expect(screen.queryByRole('button', { name: /^Approve$/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Request new challenge' })).toBeDefined()
  })

  it('flushes the dialog abort when the panel unmounts mid-challenge', async () => {
    const getApprovalChallenge = vi.fn<InboxClient['getApprovalChallenge']>(
      (_id, opts) =>
        new Promise<ApprovalChallenge>((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          )
        })
    )
    const client = makeClient({ listInbox: vi.fn(async () => [APPROVAL_ITEM]), getApprovalChallenge })
    const { unmount } = renderPanel(client)
    fireEvent.click(await screen.findByRole('button', { name: 'Review Approve deploy' }))
    await waitFor(() => expect(getApprovalChallenge).toHaveBeenCalled())
    const signal = getApprovalChallenge.mock.calls[0]?.[1]?.signal
    unmount()
    expect(signal?.aborted).toBe(true)
  })
})
