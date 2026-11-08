/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../vscode/test-setup'
import Dock, { type DockProps } from '../Dock'
import CentralControlPanel from './CentralControlPanel'
import { centralControlApi, useCentralControlEnabled, CONTROL_PATH, HALT_PATH } from './centralControlApi'
import { resetCapabilitiesCache } from '../useCapabilities'
import { fakeClient } from './centralFixtures.testutil'
import SecondarySideBar from '../App.secondarySideBar'
import { reloadSideBarFromStorage, setSideBar } from '../secondarySideBar.store'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('flag gate', () => {
  const stubCaps = (fetchImpl: () => Promise<Response>) => vi.stubGlobal('fetch', vi.fn(fetchImpl))
  const caps = (status: string) => new Response(JSON.stringify({
    capabilities: [{ id: 'central', title: 'Central Agent', blurb: 'b', status }], advanced: {},
  }), { status: 200 })
  beforeEach(resetCapabilitiesCache)

  it('follows GET /api/capabilities: central on enables, off and unloaded stay off', async () => {
    let release: (r: Response) => void = () => {}
    stubCaps(() => new Promise<Response>((r) => { release = r }))
    const { result } = renderHook(() => useCentralControlEnabled())
    expect(result.current).toBe(false)
    release(caps('on'))
    await waitFor(() => expect(result.current).toBe(true))
    resetCapabilitiesCache()
    stubCaps(async () => caps('off'))
    const off = renderHook(() => useCentralControlEnabled())
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(off.result.current).toBe(false)
  })

  it('fails closed on reject and 401', async () => {
    for (const impl of [async () => { throw new TypeError('down') }, async () => new Response('{}', { status: 401 })]) {
      resetCapabilitiesCache()
      stubCaps(impl)
      const { result } = renderHook(() => useCentralControlEnabled())
      await waitFor(() => expect(fetch).toHaveBeenCalled())
      expect(result.current).toBe(false)
    }
  })

  it('prop override wins over the server answer', async () => {
    stubCaps(async () => caps('on'))
    expect(renderHook(() => useCentralControlEnabled(false)).result.current).toBe(false)
    expect(renderHook(() => useCentralControlEnabled(true)).result.current).toBe(true)
  })

  it('does not set state after unmount', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    let release: (r: Response) => void = () => {}
    stubCaps(() => new Promise<Response>((r) => { release = r }))
    const { unmount } = renderHook(() => useCentralControlEnabled())
    unmount()
    release(caps('on'))
    await new Promise((r) => setTimeout(r, 0))
    expect(err).not.toHaveBeenCalled()
    err.mockRestore()
  })

  it('no import.meta.env in the flag files', () => {
    for (const f of ['centralControlApi.ts', 'CentralControlPanel.tsx']) {
      expect(readFileSync(new URL(f, import.meta.url), 'utf8')).not.toContain('import.meta.env')
    }
  })

  it('flag off renders nothing even when open', () => {
    const client = fakeClient()
    const { container } = render(<CentralControlPanel open enabled={false} client={client} />)
    expect(container.innerHTML).toBe('')
    expect(client.getControl).not.toHaveBeenCalled()
  })

  it('closed renders nothing', () => {
    const { container } = render(<CentralControlPanel open={false} enabled client={fakeClient()} />)
    expect(container.innerHTML).toBe('')
  })
})

describe('CentralControlPanel', () => {
  it('has tab roles, a privacy label for free models, and switches tabs by keyboard', async () => {
    render(<CentralControlPanel open enabled client={fakeClient()} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['Control', 'Agents', 'Skills', 'Memory'])
    const note = await screen.findByRole('note')
    expect(note.textContent).toContain('sent to the model provider')
    expect(note.textContent).toContain('opencode/free')
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Memory' }), { button: 0 })
    expect(await screen.findByRole('table')).toBeTruthy()
  })

  it('shows no privacy label for a non-free model', async () => {
    const client = fakeClient({ getStatus: vi.fn(async () => ({ budget: { day: 'd', used: { tokens: 0, spawns: 0 }, limits: { tokens: 0, spawns: 0 } }, model: { id: 'paid', free: false } })) })
    render(<CentralControlPanel open enabled client={client} />)
    await screen.findByText(/unlimited/)
    expect(screen.queryByRole('note')).toBeNull()
  })
})

describe('Dock item', () => {
  const noop = () => {}
  const props: DockProps = {
    onAddTerminal: noop, onAddAgent: noop, onCreateWorkspace: noop, onBrowse: noop,
    onUndo: noop, onRedo: noop, canUndo: false, canRedo: false, onBack: noop, onForward: noop, canBack: false, canForward: false,
    onFit: noop, onToggleBoard: noop, sessionsOpen: false, onToggleSessions: noop,
    zoomPct: 100, onZoomIn: noop, onZoomOut: noop, locked: false, onToggleLock: noop, cleanView: false, onToggleCleanView: noop,
  }

  it('one Central icon toggles the side bar on Chat; the shield icon is gone', () => {
    const onToggleChat = vi.fn()
    const { container } = render(<Dock {...props} onToggleChat={onToggleChat} needsYouCount={0} />)
    expect(container.querySelector('.codicon-shield')).toBeNull()
    expect(screen.queryByLabelText(/central control panel/i)).toBeNull()
    expect(screen.getAllByRole('button', { name: /^Central/ })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Central' }))
    expect(onToggleChat).toHaveBeenCalledTimes(1)
  })
})

describe('Central not ready: the Chat tab offers it', () => {
  const caps = (status: string, step?: { kind: string; label: string }) => new Response(JSON.stringify({
    capabilities: [{ id: 'central', title: 'Central Agent', blurb: 'Assistant.', status, ...(step ? { step } : {}) }],
    advanced: { agentEngine: { value: 'auto', detected: 'off' } },
  }))
  // Capabilities GET answers `capsRes`; the launch-profile check (a POST) fails, so its card shows the fix link.
  const route = (capsRes: () => Response) => vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (String(url).startsWith('/api/capabilities')) return method === 'GET' ? capsRes() : new Response('{}')
    return method === 'GET' ? new Response('[]') : new Response('{}', { status: 500 })
  })
  beforeEach(() => { resetCapabilitiesCache(); localStorage.clear(); reloadSideBarFromStorage(); setSideBar({ open: true, view: 'chat' }) })
  afterEach(() => { localStorage.clear(); reloadSideBarFromStorage() })

  it('shows Set up Claude Code above the chat, leading to Settings › Agent launch profiles', async () => {
    vi.stubGlobal('fetch', route(() => caps('needs-step', { kind: 'agentEngine', label: 'Set up Claude Code' })))
    render(<SecondarySideBar centralEnabled={false} />)
    const setup = await screen.findByRole('button', { name: 'Set up Claude Code' })
    expect(setup.closest('[data-slot="central-setup"]')?.closest('.vscode-bottom-panel__pane')?.hasAttribute('hidden')).toBe(false)
    fireEvent.click(setup)
    // Claude launch profile card: its link opens Settings › Agent (Claude launch profiles, Test).
    const opened = vi.fn()
    window.addEventListener('webterm:open-settings', opened)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit launch profile' }))
    expect((opened.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ section: 'agent' })
    window.removeEventListener('webterm:open-settings', opened)
  })

  it('off: Turn on posts the Central switch; ready: no offer and the Control tab is listed', async () => {
    const f = route(() => caps('off'))
    vi.stubGlobal('fetch', f)
    const { unmount } = render(<SecondarySideBar centralEnabled={false} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on' }))
    await waitFor(() => expect(f.mock.calls.some(([url, init]) => url === '/api/capabilities/central' && JSON.parse(String(init?.body)).enabled === true)).toBe(true))
    unmount()
    resetCapabilitiesCache()
    vi.stubGlobal('fetch', route(() => caps('on')))
    render(<SecondarySideBar centralEnabled />)
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Chat', 'Control'])
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(document.querySelector('[data-slot="central-setup"]')).toBeNull()
  })
})

describe('centralControlApi wire', () => {
  it('parses control and halts via POST', async () => {
    const calls: { url: string; method: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' })
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
      if (url === CONTROL_PATH) return json({ ceiling: 'act_gated', effective: 'observe', global: { level: 'propose', version: 2, reason: null } })
      if (url === HALT_PATH) return json({ halted: true })
      return json({ items: [] })
    }))
    expect((await centralControlApi.getControl()).effective).toBe('observe')
    await centralControlApi.halt('why')
    await waitFor(() => expect(calls.at(-1)).toEqual({ url: HALT_PATH, method: 'POST' }))
  })
})
