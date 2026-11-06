/**
 * @vitest-environment jsdom
 *
 * Drives the real attention path of a terminal agent node: view status -> `unread#noteStatus` ->
 * `osNotify` gate -> mocked `Notification`. Workspaces come from a mocked `fetchWorkspaces`.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { unreadIds, watchNode } from '../unread'
import { COALESCE_MS } from '../osNotify'
import { fakeAgentChatTransport } from './agentChatTransport.fake'
import { AgentChatView } from './agentChatView'

vi.mock('../api', () => ({
  fetchWorkspaces: vi.fn(async () => [{ id: 'ws', name: 'Alpha', nodes: ['hidden', 'watched', 'fanout'].map((id) => ({ id, title: `Chat ${id}` })) }]),
}))

class FakeNotification {
  static permission: NotificationPermission = 'granted'
  static shown: FakeNotification[] = []
  onclick: (() => void) | null = null
  close = vi.fn()
  constructor(public title: string, public opts: NotificationOptions) { FakeNotification.shown.push(this) }
}

let visibility: DocumentVisibilityState = 'hidden'
let focused = false

beforeEach(() => {
  localStorage.setItem('webterm.osNotify', JSON.stringify({ sound: false }))
  FakeNotification.shown = []
  vi.stubGlobal('Notification', FakeNotification)
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

/** A turn that runs (status line shows it) and then ends, as two separate deliveries. */
async function runTurn(nodeId: string, extra: Parameters<ReturnType<typeof fakeAgentChatTransport>['emit']> = []) {
  const { t, emit } = fakeAgentChatTransport()
  render(<AgentChatView nodeId={nodeId} onNodeData={() => {}} transport={t} />)
  emit({ seq: 1, t: 'status', status: 'thinking' }, ...extra)
  await screen.findByText(/Thinking…|Running/)
  emit({ seq: 9, t: 'status', status: 'idle' })
  await waitFor(() => expect(screen.queryByText(/Thinking…|Running/)).toBeNull())
  // Past the coalesce window, so a notification that is coming has come.
  await new Promise((r) => setTimeout(r, COALESCE_MS + 200))
}

describe('Agent Chat attention', () => {
  it('notifies and marks unread when a turn ends while the tab is hidden', async () => {
    visibility = 'hidden'
    focused = false
    await runTurn('hidden')
    expect(FakeNotification.shown.map((n) => n.title)).toEqual(['Chat hidden finished'])
    expect(unreadIds().has('hidden')).toBe(true)
  })

  it('stays quiet while the user is looking at the selected node', async () => {
    visibility = 'visible'
    focused = true
    watchNode('watched')
    await runTurn('watched')
    expect(FakeNotification.shown).toEqual([])
    expect(unreadIds().has('watched')).toBe(false)
  })

  it('a turn that ends while a subagent still runs is marked unread without a notification (nodeterm quiet rule)', async () => {
    visibility = 'hidden'
    focused = false
    await runTurn('fanout', [{ seq: 2, t: 'tool', id: 'sub', name: 'Task', input: {}, state: 'running' }])
    expect(FakeNotification.shown).toEqual([])
    expect(unreadIds().has('fanout')).toBe(true)
  })
})
