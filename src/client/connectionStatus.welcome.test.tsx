/** @vitest-environment jsdom */
// The real App on the Welcome screen (no workspace, so no terminal ever subscribes): the shared
// socket still opens at sign-in, so the strip does not sit on "Connecting…" with no attempt behind
// it. Only `WebSocket` and `fetch` are faked; the connect decision is production code.
import { screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { mountHeld, unmountCanvas } from './canvasHarness'
import { getConnection } from './ws.connection'
import { CONNECTION_TEXT } from './ConnectionStatus'

class FakeWS {
  static instances: FakeWS[] = []
  static OPEN = 1
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) { FakeWS.instances.push(this) }
  send() {}
  close() {}
  up() { this.readyState = FakeWS.OPEN; this.onopen!() }
}

afterEach(() => { unmountCanvas(); FakeWS.instances.length = 0 })

test('the Welcome screen opens the shared socket, reaches connected and shows no strip', async () => {
  vi.stubGlobal('WebSocket', FakeWS)
  const release = mountHeld({ nodes: [], dirs: {}, blank: true })
  await release()
  await screen.findByText('A canvas of terminals. Start a project to begin.')
  await waitFor(() => expect(FakeWS.instances).toHaveLength(1))
  expect(getConnection().phase).toBe('connecting') // a real attempt is in flight
  FakeWS.instances[0].up()
  await waitFor(() => expect(getConnection().phase).toBe('connected'))
  expect(screen.getByRole('status', { name: CONNECTION_TEXT.label }).textContent).toBe('')
})
