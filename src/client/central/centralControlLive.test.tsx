/** @vitest-environment jsdom */
// Status stays honest and current; the Agents tab shows what is running and can jump to it.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../vscode/test-setup'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { InboxApiError } from '../inboxTypes'
import { setNotifyCanvas } from '../osNotify'
import { setSideBar } from '../secondarySideBar.store'
import { SettingsProvider } from '../useSettings'
import AgentList from './AgentList'
import CentralControlPanel from './CentralControlPanel'
import LevelPanel, { livenessText } from './LevelPanel'
import { LIVE_REFRESH_MS } from './centralLoad'
import { CL } from './centralLabels'
import { fakeClient } from './centralFixtures.testutil'
import type { AgentRow, BoardNodeRow, ControlView, StatusView } from './centralControlTypes'

Element.prototype.scrollIntoView = () => {} // test-only: jsdom has none and Radix Select calls it

afterEach(() => { cleanup(); vi.useRealTimers(); setSideBar({ open: false, view: 'chat' }) })

const level = (effective: ControlView['effective']): ControlView => ({ ceiling: 'act_envelope', effective, global: { level: effective, version: 1, reason: null } })
const statusWith = (tokens: number, lastTurn: StatusView['lastTurn'] = null): StatusView =>
  ({ budget: { day: 'd', used: { tokens, spawns: 0 }, limits: { tokens: 1000, spawns: 20 } }, model: { id: 'paid', free: false }, lastTurn })
const agent = (over: Partial<AgentRow>): AgentRow =>
  ({ id: 'ag1', projectId: 'p1', kind: 'claude', role: 'worker', runner: 'pty', state: 'working', owner: 'central:c1', nodeId: null, startedAt: 1, projectName: 'Alpha', nodeOnBoard: false, ...over })
const boardNode = (over: Partial<BoardNodeRow> = {}): BoardNodeRow =>
  ({ nodeId: 'n1', workspaceId: 'w1', projectId: 'p1', projectName: 'Alpha', kind: 'agentChat', title: 'Fix login', live: true, status: 'thinking', ...over })
const withSkip = (on: boolean, ui: React.ReactElement) => <SettingsProvider value={{ ...DEFAULT_SETTINGS, skipApprovals: on }}>{ui}</SettingsProvider>

describe('Status refresh (policy: the panel stays mounted behind Chat, so showing it again must re-read)', () => {
  it('re-fetches status when the view returns to Control', async () => {
    setSideBar({ open: true, view: 'central' })
    const client = fakeClient({ getControl: vi.fn(async () => level('propose')) })
    render(<CentralControlPanel open enabled client={client} />)
    await screen.findByTestId('level-effective')
    await waitFor(() => expect(client.getStatus).toHaveBeenCalledTimes(1))
    act(() => setSideBar({ view: 'chat' }))
    expect(client.getStatus).toHaveBeenCalledTimes(1)
    act(() => setSideBar({ view: 'central' }))
    await waitFor(() => expect(client.getStatus).toHaveBeenCalledTimes(2))
    expect(client.getControl).toHaveBeenCalledTimes(2)
  })

  it('polls only while visible', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const client = fakeClient()
    const { rerender } = render(<LevelPanel client={client} visible />)
    await act(async () => { await Promise.resolve() })
    expect(client.getStatus).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(LIVE_REFRESH_MS) })
    expect(client.getStatus).toHaveBeenCalledTimes(2)
    rerender(<LevelPanel client={client} visible={false} />)
    await act(async () => { vi.advanceTimersByTime(LIVE_REFRESH_MS * 3) })
    expect(client.getStatus).toHaveBeenCalledTimes(2)
  })

  it('keeps the shown numbers, with no loading line, during a background refresh and after it fails', async () => {
    let finish: (s: StatusView) => void = () => {}
    let fail: (e: Error) => void = () => {}
    const getStatus = vi.fn()
      .mockResolvedValueOnce(statusWith(100))
      .mockImplementationOnce(() => new Promise<StatusView>((res) => { finish = res }))
      .mockImplementationOnce(() => new Promise<StatusView>((_, rej) => { fail = rej }))
    const { rerender } = render(<LevelPanel client={fakeClient({ getStatus })} visible />)
    await screen.findByText('100 of 1K tokens today')
    rerender(<LevelPanel client={fakeClient({ getStatus })} visible={false} />)
    rerender(<LevelPanel client={fakeClient({ getStatus })} visible />)
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText('100 of 1K tokens today')).toBeTruthy()
    await act(async () => { finish(statusWith(200)) })
    expect(await screen.findByText('200 of 1K tokens today')).toBeTruthy()
    rerender(<LevelPanel client={fakeClient({ getStatus })} visible={false} />)
    rerender(<LevelPanel client={fakeClient({ getStatus })} visible />)
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(3))
    await act(async () => { fail(new TypeError('offline')) })
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('200 of 1K tokens today')).toBeTruthy()
  })
})

describe('Status honesty', () => {
  it('does not promise asking while approvals are skipped, and keeps both Change buttons', async () => {
    render(withSkip(true, <LevelPanel client={fakeClient({ getControl: vi.fn(async () => level('act_gated')) })} />))
    expect((await screen.findByTestId('level-effective')).textContent).toBe('L3')
    expect(screen.getByText(CL.levelApprovalsSkipped)).toBeTruthy()
    expect(screen.queryByText(/asks? (you )?before/)).toBeNull()
    expect(screen.queryByText(/Approvals: skipped/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Change in Central settings' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Change in Agent settings' })).toBeTruthy()
  })

  it('keeps the plain level meaning when approvals are on', async () => {
    render(withSkip(false, <LevelPanel client={fakeClient({ getControl: vi.fn(async () => level('act_gated')) })} />))
    expect((await screen.findByTestId('level-effective')).textContent).toBe('L3 Starts workers, asks before risky steps')
    expect(screen.getByText(/asks you before anything risky/)).toBeTruthy()
  })

  it('at a level that cannot act, skipping approvals changes nothing about its meaning', async () => {
    render(withSkip(true, <LevelPanel client={fakeClient({ getControl: vi.fn(async () => level('observe')) })} />))
    expect((await screen.findByTestId('level-effective')).textContent).toBe('L1 Chat only')
    expect(screen.queryByText(CL.levelApprovalsSkipped)).toBeNull()
    expect(screen.getByText(/Approvals: skipped/)).toBeTruthy()
  })

  it('words the liveness line for no turn, a running turn and a finished one', async () => {
    expect(livenessText(null)).toBe('No turns yet')
    expect(livenessText({ at: 1, status: 'running' })).toBe('Working now')
    expect(livenessText({ at: 1, status: 'awaiting_approval' })).toBe('Working now')
    expect(livenessText({ at: 0, status: 'succeeded' }, 12 * 60_000)).toBe('Last turn 12m ago · Idle')
    render(<LevelPanel client={fakeClient({ getStatus: vi.fn(async () => statusWith(1, { at: Date.now(), status: 'running' })) })} />)
    expect((await screen.findByTestId('central-liveness')).textContent).toBe('Working now')
  })
})

describe('Agents tab', () => {
  it('asks for live agents by default and for all after "Show finished"', async () => {
    const client = fakeClient()
    render(<AgentList client={client} />)
    await screen.findByTestId('state-ag1')
    expect(vi.mocked(client.listAgents).mock.calls[0]?.[2]).toEqual({ live: true, projectId: undefined })
    fireEvent.click(screen.getByRole('switch', { name: CL.showFinished }))
    await waitFor(() => expect(vi.mocked(client.listAgents).mock.lastCall?.[2]).toEqual({ live: false, projectId: undefined }))
  })

  it('says none are running when the live list is empty', async () => {
    render(<AgentList client={fakeClient({ listAgents: vi.fn(async () => []) })} />)
    expect(await screen.findByText(CL.agentsNoneLive)).toBeTruthy()
  })

  it('offers no relay or close on a finished agent', async () => {
    const client = fakeClient({ listAgents: vi.fn(async () => [agent({ id: 'live' }), agent({ id: 'old', state: 'closed' })]) })
    render(<AgentList client={client} />)
    await screen.findByTestId('state-old')
    expect(screen.getByRole('button', { name: 'Relay live' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close live' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Relay old' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Close old' })).toBeNull()
  })

  it('narrows both lists by the project picked in the select', async () => {
    const client = fakeClient({ listBoardNodes: vi.fn(async () => ({ items: [boardNode()], projects: [{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }] })) })
    render(<AgentList client={client} />)
    await screen.findByText('Fix login')
    const select = screen.getByRole('combobox', { name: CL.projectFilter })
    expect(select.textContent).toBe(CL.allProjects)
    fireEvent.keyDown(select, { key: 'Enter' })
    fireEvent.click(screen.getByRole('option', { name: 'Beta' }))
    await waitFor(() => expect(vi.mocked(client.listAgents).mock.lastCall?.[2]).toEqual({ live: true, projectId: 'p2' }))
    await waitFor(() => expect(vi.mocked(client.listBoardNodes).mock.lastCall?.[1]).toBe('p2'))
  })

  it('lists board nodes with project and status, and Open node flies to the node', async () => {
    const focus = vi.fn()
    const uninstall = setNotifyCanvas({ focus })
    render(<AgentList client={fakeClient({ listBoardNodes: vi.fn(async () => ({ items: [boardNode(), boardNode({ nodeId: 'n2', title: 'Idle one', live: false, status: null })], projects: [] })) })} />)
    const list = await screen.findByRole('list', { name: CL.boardHeading })
    expect(within(list).getByText('Fix login')).toBeTruthy()
    expect(within(list).getAllByText('Alpha')).toHaveLength(2)
    expect(screen.getByTestId('node-status-n1').textContent).toBe('thinking')
    expect(screen.getByTestId('node-status-n2').textContent).toBe(CL.nodeNotRunning)
    fireEvent.click(screen.getByRole('button', { name: 'Open node Fix login' }))
    expect(focus).toHaveBeenCalledWith('n1')
    uninstall()
  })

  it('still lists board nodes when agents are off, and shows board empty and error states', async () => {
    const client = fakeClient({ listBoardNodes: vi.fn(async () => { throw new InboxApiError('x', 500, 'internal_error') }) })
    render(<AgentList client={client} />)
    expect((await screen.findByRole('alert')).textContent).toBe(CL.loadFailed)
    cleanup()
    render(<AgentList client={fakeClient({ listAgents: vi.fn(async () => { throw new InboxApiError('off', 503, 'agents_off') }), listBoardNodes: vi.fn(async () => ({ items: [], projects: [] })) })} />)
    expect(await screen.findByText(CL.agentsOff)).toBeTruthy()
    expect(await screen.findByText(CL.boardEmpty)).toBeTruthy()
  })

  it('shows Open node only with a node, disabled with the reason when the node is gone', async () => {
    const focus = vi.fn()
    const uninstall = setNotifyCanvas({ focus })
    const client = fakeClient({ listAgents: vi.fn(async () => [agent({ id: 'none' }), agent({ id: 'here', nodeId: 'n9', nodeOnBoard: true }), agent({ id: 'gone', nodeId: 'n8', nodeOnBoard: false })]) })
    render(<AgentList client={client} />)
    await screen.findByTestId('state-gone')
    expect(screen.queryByRole('button', { name: 'Open node none' })).toBeNull()
    expect((screen.getByRole('button', { name: 'Open node gone' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(CL.nodeGone)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open node here' }))
    expect(focus).toHaveBeenCalledWith('n9')
    uninstall()
  })
})
