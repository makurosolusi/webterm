/** @vitest-environment jsdom */
// Spawning with profiles: the menus' rows, "Browser with profile…" (one click), and "Open a browser for each profile…"
// (N nodes in a grid with their profileId, the board's Default without one, the live limit opens what fits).
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildCanvasMenuRows } from './canvasMenu.model'
import type { CanvasMenuRow } from './canvasMenu.model'
import { buildHandleEntries, OFF_HINTS } from './handleMenu.model'
import type { HandleSpawners } from './handleMenu.model'
import { fakeBrowserServer, prof } from './browserProfile.fake'
import type { FakeServer } from './browserProfile.fake'
import { openProfileSpawn, useBrowserProfileSpawn } from './browserProfile.spawn'
import BrowserProfileSpawnDialog from './BrowserProfileSpawnDialog'
import type { WsNode, Workspace } from '../shared/workspace'

const notices = vi.hoisted(() => ({ show: vi.fn() }))
vi.mock('./workspaceSave.notice', () => ({ showNotice: notices.show }))
vi.mock('./activeWorkspace.context', () => ({ useActiveWorkspaceId: () => 'w1' }))

const made: { spec: Omit<WsNode, 'x' | 'y'>; at?: { x: number; y: number } }[] = []
function Host({ enabled = true }: { enabled?: boolean }): React.JSX.Element {
  useBrowserProfileSpawn({
    enabled, defaultSize: { width: 400, height: 300 }, nodesRef: { current: [] }, rf: { current: null },
    addFlowNode: (make, at) => { made.push({ spec: make(0, { id: 'w1' } as Workspace), at }) },
  })
  return <BrowserProfileSpawnDialog />
}

let server: FakeServer
beforeEach(() => {
  made.length = 0; notices.show.mockReset()
  server = fakeBrowserServer([
    prof('w1', 'Default (Main)', { isDefaultOf: 'w1' }), prof('bp-a', 'Admin'), prof('bp-b', 'Billing'), prof('bp-c', 'Support'),
  ])
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('menus', () => {
  const ctx = { nodeCount: 0, disabledAgents: [], customAgents: [], agentLaunchCommands: {} }
  const labels = (rows: CanvasMenuRow[]): string[] => rows.flatMap((r) => ('label' in r ? [r.label] : []))
  it('canvas menu lists both profile rows beside New Browser, only when browser is on', () => {
    const f = { addTerminal: vi.fn(), addFiles: vi.fn(), addAgent: vi.fn(), fitView: vi.fn() }
    expect(labels(buildCanvasMenuRows({ ...f, addBrowser: vi.fn(), addBrowserWithProfile: vi.fn(), addBrowserForEachProfile: vi.fn() }, ctx)))
      .toEqual(expect.arrayContaining(['New Browser', 'Browser with profile…', 'Open a browser for each profile…']))
    expect(labels(buildCanvasMenuRows(f, ctx)).some((l) => l.includes('profile'))).toBe(false)
  })
  it('handle menu offers them to an agent and disables them with a reason when browser is off', () => {
    const base: HandleSpawners = { addTerminal: vi.fn(), addFiles: vi.fn(), addAgent: vi.fn(), link: vi.fn() }
    const from = { id: 'a', kind: 'agent', agentId: 'claude' as const, side: 'source' as const }
    const on = buildHandleEntries({ ...base, addBrowser: vi.fn(), openBrowserProfiles: vi.fn() }, ctx, from)
    on.find((e) => e.id === 'browser-profile')?.spawn({ x: 5, y: 6 })
    const open = vi.fn()
    buildHandleEntries({ ...base, addBrowser: vi.fn(), openBrowserProfiles: open }, ctx, from).find((e) => e.id === 'browser-each')?.spawn({ x: 5, y: 6 })
    expect(open).toHaveBeenCalledWith('each', { x: 5, y: 6 })
    const off = buildHandleEntries(base, ctx, from)
    expect(off.find((e) => e.id === 'browser-profile')).toMatchObject({ disabled: true, description: OFF_HINTS['browser-profile'] })
  })
})

describe('Browser with profile…', () => {
  it('one click on a profile opens one browser carrying its profileId at the click point', async () => {
    render(<Host />)
    act(() => { openProfileSpawn('one', { x: 10, y: 20 }) })
    fireEvent.click(await screen.findByRole('button', { name: /Billing/ }))
    expect(made).toHaveLength(1)
    expect(made[0].spec).toMatchObject({ kind: 'browser', profileId: 'bp-b' })
    expect(made[0].at).toEqual({ x: 10, y: 20 })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('the board Default opens without a profileId', async () => {
    render(<Host />)
    act(() => { openProfileSpawn('one') })
    fireEvent.click(await screen.findByRole('button', { name: /Default \(Main\)/ }))
    expect(made[0].spec.profileId).toBeUndefined()
  })
  it('does nothing while the browser feature is off', () => {
    render(<Host enabled={false} />)
    act(() => { openProfileSpawn('one') })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('Open a browser for each profile…', () => {
  it('starts with every profile ticked and opens N browsers in a grid without overlap', async () => {
    render(<Host />)
    act(() => { openProfileSpawn('each') })
    const open = await screen.findByRole('button', { name: 'Open 4 browsers' })
    fireEvent.click(open)
    await waitFor(() => expect(made).toHaveLength(4))
    expect(made.map((m) => m.spec.profileId)).toEqual([undefined, 'bp-a', 'bp-b', 'bp-c'])
    const spots = made.map((m) => m.at as { x: number; y: number })
    expect(new Set(spots.map((s) => `${s.x},${s.y}`)).size).toBe(4)
  })
  it('select all / untick changes the count and the button', async () => {
    render(<Host />)
    act(() => { openProfileSpawn('each') })
    await screen.findByRole('button', { name: 'Open 4 browsers' })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Admin' }))
    expect(screen.getByRole('button', { name: 'Open 3 browsers' })).not.toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' })) // partly ticked -> all
    expect(screen.getByRole('button', { name: 'Open 4 browsers' })).not.toBeNull()
  })
  it('with no free slots nothing opens and the notice says why; with 2 free, 2 open and the rest are named', async () => {
    server.live = 6; server.maxLive = 8
    render(<Host />)
    act(() => { openProfileSpawn('each') })
    fireEvent.click(await screen.findByRole('button', { name: 'Open 4 browsers' }))
    await waitFor(() => expect(made).toHaveLength(2))
    expect(notices.show.mock.calls[0][1]).toMatchObject({ severity: 'warning', title: 'Opened 2 of 4. The limit is 8 active browsers; hide one to open the rest.' })
    made.length = 0; notices.show.mockReset(); server.live = 8
    act(() => { openProfileSpawn('each') })
    fireEvent.click(await screen.findByRole('button', { name: 'Open 4 browsers' }))
    await waitFor(() => expect(notices.show).toHaveBeenCalled())
    expect(made).toHaveLength(0)
    expect(notices.show.mock.calls[0][1].title).toBe('No browser opened. The limit is 8 active browsers; hide one first.')
  })
  it('Cancel closes without opening anything', async () => {
    render(<Host />)
    act(() => { openProfileSpawn('each') })
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(made).toHaveLength(0)
  })
})
