/**
 * @vitest-environment jsdom
 */
// Stop then Resume (agent-211-A5) and the sticky failed bar (A1/A2) on a real canvas (canvasHarness).
// The terminal socket is a fake: the test plays the server's status/exit frames.
import { fireEvent, waitFor, act } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { installCanvasDom, mountCanvas, unmountCanvas } from './canvasHarness'
import { AGENT_FAILED_TEXT } from './AgentFailedBar'
import type { WsNode } from '../shared/workspace'

class FakeWS {
  static OPEN = 1
  static CONNECTING = 0
  static all: FakeWS[] = []
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) { FakeWS.all.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.() }, 0) }
  send(d: string) { this.sent.push(d) }
  close() {}
  push(m: object) { act(() => { this.onmessage?.({ data: JSON.stringify(m) }) }) }
  msgs() { return this.sent.map((s) => JSON.parse(s) as { t: string; id?: string; resume?: boolean }) }
}
const sock = () => FakeWS.all[FakeWS.all.length - 1]

/** An unsized jsdom terminal opens after `OPEN_SIZE_FALLBACK_MS`, past waitFor's default 1 s. */
const OPEN_WAIT = { timeout: 5000 }
const SID = '11111111-2222-4333-8444-555555555555' // test-only
const agentNode: WsNode = { id: 'agent-s', kind: 'agent', x: 0, y: 0, width: 420, height: 320, cmd: 'claude', agentId: 'claude', cwd: '/', title: 'agent', sessionId: SID }
const menu = (): HTMLElement | null => document.querySelector('[role="menu"][data-slot="vscode-menu"]')
const row = (label: string): HTMLElement | undefined =>
  Array.from(menu()?.querySelectorAll('button, [role="menuitem"]') ?? []).find((b) => b.textContent?.includes(label)) as HTMLElement | undefined
const failedBar = (): Element | undefined =>
  Array.from(document.querySelectorAll('[role="alert"]')).find((el) => el.textContent?.includes(AGENT_FAILED_TEXT.message))
const opens = () => sock().msgs().filter((m) => m.t === 'open' && m.id === agentNode.id)

async function openMenu(): Promise<void> {
  const body = document.querySelector('.react-flow__node-agent .node-body')
  if (!body) throw new Error('agent node body not rendered')
  fireEvent.contextMenu(body, { clientX: 300, clientY: 220 })
  await waitFor(() => expect(menu()).not.toBeNull())
}

beforeAll(installCanvasDom)
// Per test: unmountCanvas unstubs globals and resets the shared socket, so each test opens its own.
beforeEach(() => { vi.stubGlobal('WebSocket', FakeWS) })
afterEach(() => { unmountCanvas(); vi.restoreAllMocks() })

it('Stop leaves the node stopped and Resume session is offered with its sid', async () => {
  await mountCanvas({ nodes: [agentNode], dirs: {} })
  await waitFor(() => expect(opens().length).toBe(1), OPEN_WAIT)
  sock().push({ t: 'status', id: agentNode.id, status: 'working' })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  const stop = await waitFor(() => {
    const el = document.querySelector('[data-title="Stop Agent (keeps the node)"]')
    if (!el) throw new Error('no Stop button')
    return el
  })
  fireEvent.click(stop)
  expect(sock().msgs()).toContainEqual({ t: 'close', id: agentNode.id })
  // What the server answers a close on a live agent (sessionsEnd.ts).
  sock().push({ t: 'status', id: agentNode.id, status: 'stopped' })
  sock().push({ t: 'exit', id: agentNode.id, code: -1, reason: 'closed' })

  await openMenu()
  const resume = row('Resume session')
  expect(resume).toBeDefined()
  expect(resume!.getAttribute('aria-disabled') === 'true' || resume!.hasAttribute('disabled')).toBe(false)
  fireEvent.pointerDown(resume!)
  fireEvent.click(resume!)
  await waitFor(() => expect(opens().length).toBe(2), OPEN_WAIT)
  expect(opens()[1].resume).toBe(true)
})

it('a failed agent shows a sticky error whose Retry opens it again', async () => {
  await mountCanvas({ nodes: [{ ...agentNode, id: 'agent-f' }], dirs: {} })
  const id = 'agent-f'
  await waitFor(() => expect(sock().msgs().filter((m) => m.t === 'open' && m.id === id).length).toBe(1), OPEN_WAIT)
  sock().push({ t: 'status', id, status: 'failed' })
  sock().push({ t: 'exit', id, code: -1, reason: 'failed' })
  const retry = await waitFor(() => {
    const el = Array.from(failedBar()?.querySelectorAll('button') ?? []).find((b) => b.textContent === AGENT_FAILED_TEXT.retry)
    if (!el) throw new Error('no Retry')
    return el
  })
  fireEvent.click(retry)
  await waitFor(() => expect(sock().msgs().filter((m) => m.t === 'open' && m.id === id).length).toBe(2), OPEN_WAIT)
  // A fresh spawn answers with no status: the bar goes.
  sock().push({ t: 'status', id })
  await waitFor(() => expect(failedBar()).toBeUndefined())
})
