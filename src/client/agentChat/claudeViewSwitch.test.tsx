/** @vitest-environment jsdom */
// Chat <-> terminal view switch of a Claude node: the request it sends, per-node switching state, the
// refusal / network toast, the confirm before stopping a running turn, and when each node chrome shows,
// disables or hides the [Terminal | Chat] control.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ReactFlow, type Node } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../vscode/test-setup'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { SettingsProvider } from '../useSettings'
import AgentChatNode from '../AgentChatNode'
import { ClaudeTerminalViewToggle, ClaudeViewToggle, CLAUDE_VIEW_TEXT, STOP_RETRY_MS, switchClaudeView } from './claudeViewSwitch'

// The chat body is stubbed: the test drives its busy report through `onBusy`, as the real view does.
let reportBusy: ((busy: boolean) => void) | undefined
vi.mock('./agentChatView', () => ({
  AgentChatView: ({ onBusy }: { onBusy?: (busy: boolean) => void }) => { reportBusy = onBusy; return null },
}))

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean; ResizeObserver?: never }
g.IS_REACT_ACT_ENVIRONMENT = true

const fetchMock = vi.fn<typeof fetch>()
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
/** The [Terminal | Chat] control of a node, its options and its tooltip text. */
const toggle = (c: ParentNode) => c.querySelector<HTMLElement>('.claude-view-toggle')
const option = (c: ParentNode, name: 'Terminal' | 'Chat') => within(toggle(c)!).getByRole('radio', { name }) as HTMLButtonElement
const tipOf = (el: Element): string | null | undefined => {
  fireEvent.keyDown(document, { key: 'Tab' }) // keyboard modality: focus alone does not open a tooltip
  fireEvent.focus(el)
  const text = document.querySelector('[role="tooltip"]')?.textContent
  fireEvent.blur(el)
  return text
}
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
    expect(await switchClaudeView('n1', 'chat')).toEqual({ ok: false, message: 'Hint from the server.', code: 'busy' })
    fetchMock.mockResolvedValueOnce(reply(409, { ok: false, code: 'busy' }))
    expect(await switchClaudeView('n1', 'chat')).toEqual({ ok: false, message: 'Claude is working. Switch when it finishes, or stop it first.', code: 'busy' })
    fetchMock.mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 }))
    expect(await switchClaudeView('n1', 'chat')).toEqual({ ok: false, message: CLAUDE_VIEW_TEXT.network, code: 'http_502' })
  })

  it('a network error returns the try-again text and is logged with the node id', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    expect(await switchClaudeView('n1', 'chat')).toEqual({ ok: false, message: 'Could not switch view. Try again.', code: 'network' })
    expect(console.error).toHaveBeenCalledWith('switch claude view node n1 to chat:', expect.any(TypeError))
  })
})

describe('ClaudeViewToggle', () => {
  it('is a labelled radio group showing the current view; choosing the other one switches', async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true, node: {} }))
    const { container } = render(<ClaudeViewToggle nodeId="a" view="terminal" busy={false} />)
    expect(screen.getByRole('radiogroup', { name: 'View' })).toBeTruthy()
    expect(option(container, 'Terminal').getAttribute('aria-checked')).toBe('true')
    expect(option(container, 'Chat').getAttribute('aria-checked')).toBe('false')
    expect(tipOf(toggle(container)!)).toBe(CLAUDE_VIEW_TEXT.toChat)
    fireEvent.click(option(container, 'Terminal')) // the current view: nothing to do
    expect(fetchMock).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(option(container, 'Chat')) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ to: 'chat' })
  })

  it('an arrow key landing on the current view sends nothing; landing on the other view switches', async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true, node: {} }))
    const { container } = render(<ClaudeViewToggle nodeId="a" view="terminal" busy={false} />)
    fireEvent.keyDown(option(container, 'Chat'), { key: 'ArrowRight' }) // wraps onto Terminal, the current view
    expect(fetchMock).not.toHaveBeenCalled()
    await act(async () => { fireEvent.keyDown(option(container, 'Terminal'), { key: 'ArrowRight' }) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ to: 'chat' })
  })

  it('switching disables only that node (aria-busy, options disabled), then re-enables it', async () => {
    const d = deferred()
    fetchMock.mockReturnValue(d.promise)
    const { container } = render(<><div id="a"><ClaudeViewToggle nodeId="a" view="terminal" busy={false} /></div><div id="b"><ClaudeViewToggle nodeId="b" view="terminal" busy={false} /></div></>)
    const a = container.querySelector('#a')!
    const b = container.querySelector('#b')!
    fireEvent.click(option(a, 'Chat'))
    expect(toggle(a)!.getAttribute('aria-busy')).toBe('true')
    expect(option(a, 'Chat').disabled).toBe(true)
    expect(tipOf(toggle(a)!)).toBe(CLAUDE_VIEW_TEXT.switching)
    expect(option(b, 'Chat').disabled).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => { d.resolve(reply(200, { ok: true, node: {} })); await d.promise })
    expect(toggle(a)!.hasAttribute('aria-busy')).toBe(false)
    expect(option(a, 'Chat').disabled).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a refusal shows a warning toast with the hint; closing it clears it', async () => {
    fetchMock.mockResolvedValue(reply(409, { ok: false, code: 'busy', hint: 'Claude is working. Switch when it finishes, or stop it first.' }))
    const { container } = render(<ClaudeViewToggle nodeId="a" view="chat" busy={false} />)
    await act(async () => { fireEvent.click(option(container, 'Terminal')) })
    const toast = await screen.findByRole('alert')
    expect(toast.textContent).toContain('Could not switch view')
    expect(toast.textContent).toContain('Claude is working. Switch when it finishes, or stop it first.')
    fireEvent.click(screen.getByLabelText('Close notification'))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a network error shows the try-again toast', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    const { container } = render(<ClaudeViewToggle nodeId="a" view="terminal" busy={false} />)
    await act(async () => { fireEvent.click(option(container, 'Chat')) })
    expect((await screen.findByRole('alert')).textContent).toContain('Could not switch view. Try again.')
  })

  it('busy without a way to stop: disabled with the working tooltip, and a click sends nothing', () => {
    const { container } = render(<ClaudeViewToggle nodeId="a" view="chat" busy />)
    expect(option(container, 'Terminal').disabled).toBe(true)
    expect(tipOf(toggle(container)!)).toBe(CLAUDE_VIEW_TEXT.busy)
    fireEvent.click(option(container, 'Terminal'))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('busy with Stop: asks first; Cancel changes nothing, "Stop and switch" stops the turn then switches', async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true, node: {} }))
    const onStopTurn = vi.fn()
    const { container } = render(<ClaudeViewToggle nodeId="a" view="terminal" busy onStopTurn={onStopTurn} />)
    fireEvent.click(option(container, 'Chat'))
    const dialog = screen.getByRole('alertdialog')
    expect(dialog.textContent).toContain('Stop Claude and switch to Chat?')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(onStopTurn).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.click(option(container, 'Chat'))
    await act(async () => { fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Stop and switch' })) })
    expect(onStopTurn).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ to: 'chat' })
  })

  it('after Stop, a busy refusal (the server had not seen the Stop yet) is retried once', async () => {
    vi.useFakeTimers()
    try {
      fetchMock.mockResolvedValueOnce(reply(409, { ok: false, code: 'busy' })).mockResolvedValueOnce(reply(200, { ok: true, node: {} }))
      const { container } = render(<ClaudeViewToggle nodeId="a" view="terminal" busy onStopTurn={() => {}} />)
      fireEvent.click(option(container, 'Chat'))
      await act(async () => { fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Stop and switch' })) })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(STOP_RETRY_MS) })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(screen.queryByRole('alert')).toBeNull()
    } finally { vi.useRealTimers() }
  })
})

describe('Claude terminal node: [Terminal | Chat]', () => {
  const show = (p: Parameters<typeof ClaudeTerminalViewToggle>[0], disabledAgents: string[] = []) =>
    render(<SettingsProvider value={{ ...DEFAULT_SETTINGS, disabledAgents: disabledAgents as never }}><ClaudeTerminalViewToggle {...p} /></SettingsProvider>).container

  it('idle single-pane Claude terminal: Terminal checked, Chat enabled', () => {
    const c = show({ nodeId: 'n1', agentId: 'claude', status: 'done' })
    expect(option(c, 'Terminal').getAttribute('aria-checked')).toBe('true')
    expect(option(c, 'Chat').disabled).toBe(false)
  })

  it.each(['working', 'blocked'] as const)('status %s without Stop: disabled with the working tooltip', (status) => {
    const c = show({ nodeId: 'n1', agentId: 'claude', status })
    expect(option(c, 'Chat').disabled).toBe(true)
    expect(tipOf(toggle(c)!)).toBe(CLAUDE_VIEW_TEXT.busy)
  })

  it('status working with Stop: enabled, the switch asks first', () => {
    const c = show({ nodeId: 'n1', agentId: 'claude', status: 'working', onStopTurn: () => {} })
    fireEvent.click(option(c, 'Chat'))
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("status waiting (idle after Stop): enabled", () => {
    expect(option(show({ nodeId: 'n1', agentId: 'claude', status: 'waiting' }), 'Chat').disabled).toBe(false)
  })

  it('hidden for other agents, plain terminals, split panes, and when Claude is disabled in settings', () => {
    expect(toggle(show({ nodeId: 'n1', agentId: 'codex' as never }))).toBeNull()
    expect(toggle(show({ nodeId: 'n1' }))).toBeNull()
    const split = { dir: 'h' as const, ratio: 0.5, a: { id: 'n1' }, b: { id: 'n1:p1' } }
    expect(toggle(show({ nodeId: 'n1', agentId: 'claude', panes: split }))).toBeNull()
    expect(toggle(show({ nodeId: 'n1', agentId: 'claude' }, ['claude']))).toBeNull()
    // A stored single leaf is still one pane.
    expect(toggle(show({ nodeId: 'n1', agentId: 'claude', panes: { id: 'n1' } }))).not.toBeNull()
  })
})

describe('Agent Chat node: [Terminal | Chat]', () => {
  const chatNode: Node = { id: 'c1', type: 'agentChat', position: { x: 0, y: 0 }, width: 400, height: 400, data: { kind: 'agentChat', agentId: 'claude' } }
  const board = () => render(<div style={{ width: 800, height: 600 }}><ReactFlow nodeTypes={{ agentChat: AgentChatNode }} nodes={[chatNode]} edges={[]} /></div>).container

  it('in the header with Chat checked; disabled while the chat reports busy, enabled again after', async () => {
    const c = board()
    await act(async () => { await vi.dynamicImportSettled() })
    expect(toggle(c)!.closest('.node-header')).not.toBeNull()
    expect(option(c, 'Chat').getAttribute('aria-checked')).toBe('true')
    expect(option(c, 'Terminal').disabled).toBe(false)
    act(() => reportBusy?.(true))
    expect(option(c, 'Terminal').disabled).toBe(true)
    act(() => reportBusy?.(false))
    expect(option(c, 'Terminal').disabled).toBe(false)
  })

  it('choosing Terminal switches this node to the terminal view', async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true, node: {} }))
    const c = board()
    await act(async () => { await vi.dynamicImportSettled() })
    await act(async () => { fireEvent.click(option(c, 'Terminal')) })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/claude-view/c1')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ to: 'terminal' })
  })
})
