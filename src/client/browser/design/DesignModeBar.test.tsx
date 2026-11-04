/** @vitest-environment jsdom */
// Design Mode bar: toggle hits the design route, Send posts the comment, unmount turns the overlay off.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../vscode/test-setup'
import DesignModeBar, { DESIGN_TEXT } from './DesignModeBar'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function stubFetch(reply: (url: string, body: Record<string, unknown>) => [number, unknown]) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push({ url, body })
    const [status, data] = reply(url, body)
    return new Response(JSON.stringify(data), { status })
  }))
  return calls
}

describe('DesignModeBar', () => {
  it('toggles on, sends the comment, reports the agents, and turns off on unmount', async () => {
    const calls = stubFetch((url, b) => (url.endsWith('/send') ? [202, { sentTo: ['a1'], picks: 1, screenshot: null }] : [200, { on: b.on }]))
    const { unmount } = render(<DesignModeBar nodeId="web1" />)
    expect(screen.queryByLabelText(DESIGN_TEXT.comment)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: DESIGN_TEXT.toggleOn }))
    const box = await screen.findByLabelText(DESIGN_TEXT.comment)
    expect(calls[0]).toEqual({ url: '/api/browser/web1/design', body: { on: true } })
    fireEvent.change(box, { target: { value: 'make this button bigger' } })
    fireEvent.click(screen.getByRole('button', { name: DESIGN_TEXT.send }))
    await screen.findByText(DESIGN_TEXT.sent(1))
    expect(calls[1]).toEqual({ url: '/api/browser/web1/design/send', body: { comment: 'make this button bigger' } })
    unmount()
    await waitFor(() => expect(calls[2]).toEqual({ url: '/api/browser/web1/design', body: { on: false } }))
  })

  it('shows the server message when sending is refused', async () => {
    stubFetch((url, b) => (url.endsWith('/send') ? [409, { error: 'no_linked_agent', message: 'No agent is wired to this browser node.' }] : [200, { on: b.on }]))
    render(<DesignModeBar nodeId="web1" />)
    fireEvent.click(screen.getByRole('button', { name: DESIGN_TEXT.toggleOn }))
    fireEvent.click(await screen.findByRole('button', { name: DESIGN_TEXT.send }))
    expect((await screen.findByRole('alert')).textContent).toBe('No agent is wired to this browser node.')
  })
})
