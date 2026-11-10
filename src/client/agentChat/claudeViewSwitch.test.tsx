/** @vitest-environment jsdom */
// Chat <-> terminal view switch of a Claude node: the request it sends, per-node switching state, the
// refusal / network toast, and when each node chrome shows, disables or hides the header button.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ReactFlow, type Node } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../vscode/test-setup'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { SettingsProvider } from '../useSettings'
import AgentChatNode from '../AgentChatNode'
import { ClaudeTerminalViewButton, ClaudeViewButton, CLAUDE_VIEW_TEXT, switchClaudeView } from './claudeViewSwitch'

// The chat body is stubbed: the test drives its busy report through `onBusy`, as the real view does.
let reportBusy: ((busy: boolean) => void) | undefined
vi.mock('./agentChatView', () => ({
  AgentChatView: ({ onBusy }: { onBusy?: (busy: boolean) => void }) => { reportBusy = onBusy; return null },
}))

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean; ResizeObserver?: never }
g.IS_REACT_ACT_ENVIRONMENT = true

const fetchMock = vi.fn<typeof fetch>()
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
/** The view-switch button heading to the view `label` names ("Open as chat" -> chat). */
const btn = (c: ParentNode, label: string) =>
  c.querySelector<HTMLElement>(`vscode-toolbar-button[data-claude-view="${label === CLAUDE_VIEW_TEXT.chat ? 'chat' : 'terminal'}"]`)
/** A promise the test resolves by hand, so "switching" can be observed mid-request. */
function deferred() {
  let resolve!: (r: Response) => void
  const promise = new Promise<Response>((r) => { resolve = r })
  return { promise, resolve }
}

beforeEach(() => {
  g.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); reportBusy = undefined })

describe('switchClaudeView', () => {
  it('POSTs {to} as JSON to /api/claude-view/:nodeId', async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true, node: { id: 'n 1', kind: 'agent' } }))
    expect(await switchClaudeView('n 1', 'terminal')).toEqual({ ok: true })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/claude-view/n%201')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(JSON.parse(String(init?.body))).toEqual({ to: 'terminal' })
  })

  it('a refusal returns the server hint, else plain text for its code, else the generic text', async () => {
    fetchMock.mockResolvedValueOnce(reply(409, { ok: false, code: 'busy', hint: 'Hint from the server.' }))
    expect(await switchClaudeView('n1', 'chat')).toEqual({ ok: false, message: 'Hint from the server.' })
    fetchMock.mockResolvedValueOnce(reply(409, { ok: false, code: 'busy' }))
    expect(await switchClaudeView('n1', 'chat')).toEqual({ ok: false, message: 'Claude is working. Switch when it finishes, or stop it first.' })
    fetchMock.mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 }))
    expect(await switchClaudeView('n1', 'chat')).toEqual({ ok: false, message: CLAUDE_VIEW_TEXT.network })
  })

  it('a network error returns the try-again text and is logged with the node id', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    expect(await switchClaudeView('n1', 'chat')).toEqual({ ok: false, message: 'Could not switch view. Try again.' })
    expect(console.error).toHaveBeenCalledWith('switch claude view node n1 to chat:', expect.any(TypeError))
  })
})

describe('ClaudeViewButton', () => {
  it('switching disables only that node (aria-disabled + aria-busy), then re-enables it', async () => {
    const d = deferred()
    fetchMock.mockReturnValue(d.promise)
    const { container } = render(<><div id="a"><ClaudeViewButton nodeId="a" to="chat" busy={false} /></div><div id="b"><ClaudeViewButton nodeId="b" to="chat" busy={false} /></div></>)
    const a = btn(container.querySelector('#a')!, 'Open as chat')!
    const b = btn(container.querySelector('#b')!, 'Open as chat')!
    fireEvent.click(a)
    expect(a.getAttribute('aria-disabled')).toBe('true')
    expect(a.getAttribute('aria-busy')).toBe('true')
    expect(a.getAttribute('data-title')).toBe('Switching view…')
    expect(b.hasAttribute('aria-disabled')).toBe(false)
    fireEvent.click(a) // ignored while in flight
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => { d.resolve(reply(200, { ok: true, node: {} })); await d.promise })
    expect(a.hasAttribute('aria-disabled')).toBe(false)
    expect(a.hasAttribute('aria-busy')).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a busy refusal shows a warning toast with the hint; closing it clears it', async () => {
    fetchMock.mockResolvedValue(reply(409, { ok: false, code: 'busy', hint: 'Claude is working. Switch when it finishes, or stop it first.' }))
    const { container } = render(<ClaudeViewButton nodeId="a" to="terminal" busy={false} />)
    await act(async () => { fireEvent.click(btn(container, 'Open as terminal')!) })
    const toast = await screen.findByRole('alert')
    expect(toast.textContent).toContain('Could not switch view')
    expect(toast.textContent).toContain('Claude is working. Switch when it finishes, or stop it first.')
    fireEvent.click(screen.getByLabelText('Close notification'))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a network error shows the try-again toast', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    const { container } = render(<ClaudeViewButton nodeId="a" to="chat" busy={false} />)
    await act(async () => { fireEvent.click(btn(container, 'Open as chat')!) })
    expect((await screen.findByRole('alert')).textContent).toContain('Could not switch view. Try again.')
  })

  it('busy: disabled with the working tooltip, and a click sends nothing', () => {
    const { container } = render(<ClaudeViewButton nodeId="a" to="chat" busy />)
    const b = btn(container, 'Open as chat')!
    expect(b.getAttribute('aria-disabled')).toBe('true')
    expect(b.getAttribute('data-title')).toBe('Claude is working. Switch when it finishes.')
    fireEvent.click(b)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('Claude terminal node: "Open as chat"', () => {
  const show = (p: Parameters<typeof ClaudeTerminalViewButton>[0], disabledAgents: string[] = []) =>
    render(<SettingsProvider value={{ ...DEFAULT_SETTINGS, disabledAgents: disabledAgents as never }}><ClaudeTerminalViewButton {...p} /></SettingsProvider>).container

  it('idle single-pane Claude terminal: enabled, tooltip "Open as chat", chat icon', () => {
    const b = btn(show({ nodeId: 'n1', agentId: 'claude', status: 'done' }), 'Open as chat')!
    expect(b.hasAttribute('aria-disabled')).toBe(false)
    expect(b.getAttribute('data-title')).toBe('Open as chat')
    expect(b.querySelector('.codicon-comment-discussion')).not.toBeNull()
  })

  it.each(['working', 'blocked'] as const)('status %s: disabled with the working tooltip', (status) => {
    const b = btn(show({ nodeId: 'n1', agentId: 'claude', status }), 'Open as chat')!
    expect(b.getAttribute('aria-disabled')).toBe('true')
    expect(b.getAttribute('data-title')).toBe('Claude is working. Switch when it finishes.')
  })

  it("status waiting (idle after Stop): enabled, tooltip 'Open as chat'", () => {
    const b = btn(show({ nodeId: 'n1', agentId: 'claude', status: 'waiting' }), 'Open as chat')!
    expect(b.hasAttribute('aria-disabled')).toBe(false)
    expect(b.getAttribute('data-title')).toBe('Open as chat')
  })

  it('hidden for other agents, plain terminals, split panes, and when Claude is disabled in settings', () => {
    expect(btn(show({ nodeId: 'n1', agentId: 'codex' as never }), 'Open as chat')).toBeNull()
    expect(btn(show({ nodeId: 'n1' }), 'Open as chat')).toBeNull()
    const split = { dir: 'h' as const, ratio: 0.5, a: { id: 'n1' }, b: { id: 'n1:p1' } }
    expect(btn(show({ nodeId: 'n1', agentId: 'claude', panes: split }), 'Open as chat')).toBeNull()
    expect(btn(show({ nodeId: 'n1', agentId: 'claude' }, ['claude']), 'Open as chat')).toBeNull()
    // A stored single leaf is still one pane.
    expect(btn(show({ nodeId: 'n1', agentId: 'claude', panes: { id: 'n1' } }), 'Open as chat')).not.toBeNull()
  })
})

describe('Agent Chat node: "Open as terminal"', () => {
  const chatNode: Node = { id: 'c1', type: 'agentChat', position: { x: 0, y: 0 }, width: 400, height: 400, data: { kind: 'agentChat', agentId: 'claude' } }
  const board = () => render(<div style={{ width: 800, height: 600 }}><ReactFlow nodeTypes={{ agentChat: AgentChatNode }} nodes={[chatNode]} edges={[]} /></div>).container

  it('in the header with the terminal icon; disabled while the chat reports busy, enabled again after', async () => {
    const c = board()
    await act(async () => { await vi.dynamicImportSettled() })
    const b = btn(c, 'Open as terminal')!
    expect(b.closest('.node-header')).not.toBeNull()
    expect(b.querySelector('.codicon-terminal')).not.toBeNull()
    expect(b.hasAttribute('aria-disabled')).toBe(false)
    expect(b.getAttribute('data-title')).toBe('Open as terminal')
    act(() => reportBusy?.(true))
    expect(b.getAttribute('aria-disabled')).toBe('true')
    expect(b.getAttribute('data-title')).toBe('Claude is working. Switch when it finishes.')
    act(() => reportBusy?.(false))
    expect(b.hasAttribute('aria-disabled')).toBe(false)
  })

  it('a click switches this node to the terminal view', async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true, node: {} }))
    const c = board()
    await act(async () => { await vi.dynamicImportSettled() })
    await act(async () => { fireEvent.click(btn(c, 'Open as terminal')!) })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/claude-view/c1')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ to: 'terminal' })
  })
})
