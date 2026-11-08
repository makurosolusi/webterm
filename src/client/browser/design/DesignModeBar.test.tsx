/** @vitest-environment jsdom */
// Design Mode: useDesignMode toggles via the design route; the bar shows only while on, Send posts the comment, unmount turns the overlay off.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../vscode/test-setup'
import DesignModeBar, { DESIGN_TEXT } from './DesignModeBar'
import { useDesignMode } from './useDesignMode'

/** The slot wiring of BrowserNode.slots.tsx: a Design Mode switch + the bar only while on. */
function Harness({ nodeId }: { nodeId: string }) {
  const design = useDesignMode(nodeId)
  return (
    <>
      <button type="button" onClick={() => void design.toggle()}>switch</button>
      {design.error && <p role="alert">{design.error}</p>}
      {design.on && <DesignModeBar nodeId={nodeId} design={design} />}
    </>
  )
}

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
    const { unmount } = render(<Harness nodeId="web1" />)
    expect(screen.queryByLabelText(DESIGN_TEXT.comment)).toBeNull() // bar absent while off
    fireEvent.click(screen.getByRole('button', { name: 'switch' }))
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
    render(<Harness nodeId="web1" />)
    fireEvent.click(screen.getByRole('button', { name: 'switch' }))
    fireEvent.click(await screen.findByRole('button', { name: DESIGN_TEXT.send }))
    expect((await screen.findByRole('alert')).textContent).toBe('No agent is wired to this browser node.')
  })

  it('Exit in the bar turns Design Mode off and removes the bar', async () => {
    const calls = stubFetch((_url, b) => [200, { on: b.on }])
    render(<Harness nodeId="web1" />)
    fireEvent.click(screen.getByRole('button', { name: 'switch' }))
    fireEvent.click(await screen.findByRole('button', { name: DESIGN_TEXT.exit }))
    await waitFor(() => expect(screen.queryByLabelText(DESIGN_TEXT.comment)).toBeNull())
    expect(calls.map((c) => c.body)).toEqual([{ on: true }, { on: false }])
  })

  it('a refused toggle stays off and reports the server message', async () => {
    stubFetch(() => [409, { message: 'Page is not ready.' }])
    render(<Harness nodeId="web1" />)
    fireEvent.click(screen.getByRole('button', { name: 'switch' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Page is not ready.')
    expect(screen.queryByLabelText(DESIGN_TEXT.comment)).toBeNull()
  })
})
