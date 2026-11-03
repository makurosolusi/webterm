/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ITEMS, makeClient, renderPanel } from './InboxPanel.fixtures'
import { InboxApiError, type InboxClient, type InboxItem } from './inboxApi'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('list states', () => {
  it('groups items into sections with counts and ages', async () => {
    renderPanel(makeClient())
    expect(await screen.findByText('Deploy main')).toBeDefined()
    expect(screen.getByRole('complementary', { name: 'Inbox' })).toBeDefined()
    const filters = within(screen.getByRole('group', { name: 'Filter inbox' }))
    expect(filters.getByRole('tab', { name: /^All/ }).textContent).toContain('4')
    expect(filters.getByRole('tab', { name: /^Needs you/ }).textContent).toContain('2')
    expect(filters.getByRole('tab', { name: /^Review/ }).textContent).toContain('1')
    expect(filters.getByRole('tab', { name: /^Broken/ }).textContent).toContain('1')
    expect(screen.getByText('2m ago')).toBeDefined()
  })

  it('shows the loading status before the list resolves', () => {
    renderPanel(makeClient({ listInbox: vi.fn(() => new Promise<InboxItem[]>(() => {})) }))
    expect(screen.getByRole('status').textContent).toContain('Loading inbox')
  })

  it('shows an empty state', async () => {
    renderPanel(makeClient({ listInbox: vi.fn(async () => []) }))
    expect(await screen.findByText('Inbox is clear.')).toBeDefined()
  })

  it('shows an alert and recovers on Retry', async () => {
    const listInbox = vi
      .fn<InboxClient['listInbox']>()
      .mockRejectedValueOnce(new InboxApiError('GET /api/inbox failed (500 http_500)', 500, 'http_500'))
      .mockResolvedValueOnce(ITEMS)
    renderPanel(makeClient({ listInbox }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('GET /api/inbox failed')
    // G-18: Retry is a secondary VS Code button, not the blue primary action.
    expect(within(alert).getByRole('button', { name: 'Retry' }).className).toContain('inbox-action--secondary')
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Deploy main')).toBeDefined()
    expect(listInbox).toHaveBeenCalledTimes(2)
  })

  it('filters by section', async () => {
    renderPanel(makeClient())
    await screen.findByText('Deploy main')
    fireEvent.click(within(screen.getByRole('group', { name: 'Filter inbox' })).getByRole('tab', { name: /^Review/ }))

    expect(screen.queryByText('Deploy main')).toBeNull()
    expect(screen.queryByText('Rotate keys')).toBeNull()
    expect(screen.getByText('Read diff')).toBeDefined()
    expect(screen.queryByRole('checkbox', { name: 'Select all in Needs you' })).toBeNull()
  })

  it('aborts the in-flight list request on unmount', async () => {
    const listInbox = vi.fn<InboxClient['listInbox']>((opts) => {
      return new Promise<InboxItem[]>((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        )
      })
    })
    const { unmount } = renderPanel(makeClient({ listInbox }))
    await waitFor(() => expect(listInbox).toHaveBeenCalled())
    const signal = listInbox.mock.calls[0]?.[0]?.signal
    unmount()
    expect(signal?.aborted).toBe(true)
  })
})

describe('stylesheet scope', () => {
  it('has no global resets and every selector is inbox-scoped', () => {
    const css = readFileSync('src/client/inbox.css', 'utf8')
    expect(css).not.toMatch(/^\s*:root/m)
    expect(css).not.toMatch(/^\s*\*/m)
    expect(css).not.toMatch(/^\s*(html|body)\b/m)
    expect(css).toMatch(/@media \(max-width: 640px\)/)
  })

  it('keeps the narrow panel flush with the activity bar instead of floating beside a dock', () => {
    // The panel is a docked VS Code panel now (inboxPanelSurface.css); the old floating-dock
    // offsets (--dock-w / --float-gap) must not come back and push it off the left edge.
    const css = readFileSync('src/client/inbox.css', 'utf8')
    expect(css).not.toContain('--dock-w')
    expect(css).not.toContain('--float-gap')
    expect(readFileSync('src/client/inboxPanelSurface.css', 'utf8')).toMatch(
      /@media \(max-width: 640px\)[\s\S]*left: var\(--activity-bar-w/
    )
  })
})
