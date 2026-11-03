/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../vscode/test-setup'
import Dock, { type DockProps } from '../Dock'
import CentralControlPanel from './CentralControlPanel'
import { centralControlApi, centralControlEnabled, CONTROL_PATH, HALT_PATH } from './centralControlApi'
import { fakeClient } from './centralFixtures.testutil'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('flag gate', () => {
  it('is off unless VITE_WEBTERM_CENTRAL_CHAT is exactly on', () => {
    expect(centralControlEnabled({})).toBe(false)
    expect(centralControlEnabled({ VITE_WEBTERM_CENTRAL_CHAT: 'off' })).toBe(false)
    expect(centralControlEnabled({ VITE_WEBTERM_CENTRAL_CHAT: 'on' })).toBe(true)
  })

  it('flag off renders nothing even when open', () => {
    const client = fakeClient()
    const { container } = render(<CentralControlPanel open enabled={false} onClose={() => {}} client={client} />)
    expect(container.innerHTML).toBe('')
    expect(client.getControl).not.toHaveBeenCalled()
  })

  it('closed renders nothing', () => {
    const { container } = render(<CentralControlPanel open={false} enabled onClose={() => {}} client={fakeClient()} />)
    expect(container.innerHTML).toBe('')
  })
})

describe('CentralControlPanel', () => {
  it('has a labelled region, tab roles, a privacy label for free models, and switches tabs by keyboard', async () => {
    render(<CentralControlPanel open enabled onClose={() => {}} client={fakeClient()} />)
    expect(screen.getByRole('complementary', { name: 'Central control' })).toBeTruthy()
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(expect.arrayContaining(['Control', 'Agents', 'Approvals', 'Skills', 'Memory']))
    const note = await screen.findByRole('note')
    expect(note.textContent).toContain('sent to the model provider')
    expect(note.textContent).toContain('opencode/free')
    fireEvent.click(screen.getByRole('tab', { name: 'Memory' }))
    expect(await screen.findByRole('table')).toBeTruthy()
  })

  it('shows no privacy label for a non-free model', async () => {
    const client = fakeClient({ getStatus: vi.fn(async () => ({ budget: { day: 'd', used: { tokens: 0, spawns: 0 }, limits: { tokens: 0, spawns: 0 } }, model: { id: 'paid', free: false } })) })
    render(<CentralControlPanel open enabled onClose={() => {}} client={client} />)
    await screen.findByText(/unlimited/)
    expect(screen.queryByRole('note')).toBeNull()
  })
})

describe('Dock item', () => {
  const noop = () => {}
  const props: DockProps = {
    onAddTerminal: noop, onAddAgent: noop, onCreateWorkspace: noop, onBrowse: noop,
    onUndo: noop, onRedo: noop, canUndo: false, canRedo: false, onBack: noop, onForward: noop, canBack: false, canForward: false,
    onFit: noop, onToggleBoard: noop, sessionsOpen: false, onToggleSessions: noop, inboxOpen: false, onToggleInbox: noop,
    zoomPct: 100, onZoomIn: noop, onZoomOut: noop, locked: false, onToggleLock: noop, cleanView: false, onToggleCleanView: noop,
  }

  it('is absent without the handler (old UI identical)', () => {
    render(<Dock {...props} />)
    expect(screen.queryByLabelText('Toggle central control panel')).toBeNull()
  })

  it('toggles when the handler is given', () => {
    const onToggleCentral = vi.fn()
    render(<Dock {...props} onToggleCentral={onToggleCentral} />)
    fireEvent.click(screen.getByLabelText('Toggle central control panel'))
    expect(onToggleCentral).toHaveBeenCalledTimes(1)
  })
})

describe('centralControlApi wire', () => {
  it('parses control, drops malformed approval rows, and halts via POST', async () => {
    const calls: { url: string; method: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' })
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
      if (url === CONTROL_PATH) return json({ ceiling: 'act_gated', effective: 'observe', global: { level: 'propose', version: 2, reason: null } })
      if (url === HALT_PATH) return json({ halted: true })
      return json({ items: [{ id: 'a', tool: 't', tier: 'R2', summary: 's', digest: 'd', nonce: 'n', expiresAt: 1, projectId: 'p', args: [{ key: 'k', value: 'v' }] }, { id: 'bad' }] })
    }))
    expect((await centralControlApi.getControl()).effective).toBe('observe')
    const cards = await centralControlApi.listApprovals()
    expect(cards).toHaveLength(1)
    expect(cards[0]?.args).toEqual([{ key: 'k', value: 'v' }])
    await centralControlApi.halt('why')
    await waitFor(() => expect(calls.at(-1)).toEqual({ url: HALT_PATH, method: 'POST' }))
  })
})
