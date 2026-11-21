/** @vitest-environment jsdom */
// A browser node that cannot operate must not look alive (owner report: a new browser with a profile, start page visible,
// nothing clickable). Covers the stand-in tab (no agent marker, still usable), the profile sent on attach, and the
// MAX_LIVE refusal: plate, hide-another list, try again, input never swallowed silently, plate gone once a state arrives.
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import type { ClientMsg, ServerMsg } from '../shared/browser.contract'
import type { BrowserListener } from './browser.stream'

const h = vi.hoisted(() => {
  const state = { listener: null as null | BrowserListener, sent: [] as ClientMsg[], attaches: [] as Array<{ id: string; vp: { w: number; h: number; dpr: number }; profileId?: string }> }
  // The board: nodes by id, with the few instance methods the node uses (a bare provider keeps no nodes to update).
  type N = { id: string; type: string; position: { x: number; y: number }; height?: number; data: Record<string, unknown> }
  const board = { nodes: [] as N[] }
  const rfFake = {
    getNodes: () => board.nodes, getNode: (id: string) => board.nodes.find((n) => n.id === id),
    updateNode: (id: string, p: Partial<N>) => { board.nodes = board.nodes.map((n) => (n.id === id ? { ...n, ...p } : n)) },
    updateNodeData: (id: string, p: Record<string, unknown>) => { board.nodes = board.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...p } } : n)) },
    deleteElements: vi.fn(),
  }
  return {
    state, board, rfFake, showNotice: vi.fn(),
    stream: {
      subscribe: (_id: string, l: BrowserListener) => { state.listener = l; return () => undefined },
      attach: (id: string, vp: { w: number; h: number; dpr: number }, profileId?: string) => { state.attaches.push({ id, vp, profileId }) },
      resize: () => undefined, setAudio: () => undefined, detach: () => undefined, reset: () => undefined,
      send: (m: ClientMsg) => { state.sent.push(m) },
    },
  }
})
vi.mock('@xyflow/react', async (orig) => ({ ...(await orig<typeof import('@xyflow/react')>()), useReactFlow: () => h.rfFake }))
vi.mock('./browser.stream', () => ({ browserStream: h.stream }))
vi.mock('./workspaceSave.notice', () => ({ showNotice: h.showNotice, closeNotice: vi.fn() }))
vi.mock('./browser.feature', () => ({ useBrowserStatus: () => ({ enabled: true, maxLive: 3 }), resetBrowserStatusCache: vi.fn() }))

import BrowserNode from './BrowserNode'

/** Reports a real size at once, so the session attaches like it does in a browser. */
class SizedRO {
  constructor(private readonly cb: (e: Array<{ contentRect: { width: number; height: number } }>) => void) {}
  observe() { this.cb([{ contentRect: { width: 800, height: 600 } }]) }
  disconnect() {}
}

const rf = h.rfFake
const OTHER = { id: 'b2', type: 'browser', position: { x: 0, y: 0 }, data: { title: 'Docs', url: 'https://docs.test/page' } }
const toolbar: ComponentProps<typeof BrowserNode>['renderToolbar'] = (ctx) => <button onClick={() => ctx.nav('go', 'https://x.test/')}>go</button>
const mount = (data: Record<string, unknown> = { title: 't' }) => render(
  <ReactFlowProvider>
    <BrowserNode {...({ id: 'b1', data, selected: false, renderToolbar: toolbar } as unknown as ComponentProps<typeof BrowserNode>)} />
  </ReactFlowProvider>,
)
const msg = (m: ServerMsg) => act(() => h.state.listener?.onMsg(m))
const live = { t: 'state', id: 'b1', url: 'https://a.test/', title: 'A', loading: false, canBack: false, canForward: false, lease: 'human', live: 'live' } as const

beforeEach(() => {
  h.state.listener = null; h.state.sent = []; h.state.attaches = []; h.showNotice.mockReset()
  h.board.nodes = [structuredClone(OTHER)]
  vi.stubGlobal('ResizeObserver', SizedRO)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('a new node before the server has answered (stand-in tab)', () => {
  it('shows one tab that is NOT marked as the agent tab, and still lets the user open a new one', () => {
    mount({ profileId: 'bp-0123456789ab' })
    const tab = screen.getAllByRole('tab')
    expect(tab).toHaveLength(1)
    expect(tab[0].getAttribute('data-agent')).toBeNull()
    expect(document.querySelector('[data-agent-marker]')).toBeNull()
    expect((screen.getByRole('button', { name: 'New tab' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('tells the server which profile the node was created on when it attaches', () => {
    mount({ profileId: 'bp-0123456789ab' })
    expect(h.state.attaches).toEqual([{ id: 'b1', vp: expect.objectContaining({ w: 800, h: 600 }), profileId: 'bp-0123456789ab' }])
  })

  it('a node on the board Default sends no profile', () => {
    mount()
    expect(h.state.attaches[0].profileId).toBeUndefined()
  })
})

describe('the MAX_LIVE gate refused the node', () => {
  const refuse = () => msg({ t: 'error', id: 'b1', code: 'max_live' })

  it('control: without the refusal the start page is there', () => {
    mount()
    expect(screen.getByPlaceholderText(/Search Google/)).toBeTruthy()
  })

  it('shows an explicit paused state with the limit instead of a start page that looks usable', () => {
    mount()
    refuse()
    const plate = screen.getByRole('alert', { name: 'Browser paused' })
    expect(plate.textContent).toContain('The limit of 3 active browsers is reached')
    expect(screen.queryByPlaceholderText(/Search Google/)).toBeNull()
  })

  it('"Hide another browser…" lists the other showing browsers and collapses the chosen one', () => {
    mount()
    refuse()
    fireEvent.click(screen.getByRole('button', { name: 'Hide another browser…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Docs · docs.test' }))
    expect(rf.getNode('b2')?.data.collapsed).toBe(true)
    expect(rf.getNode('b2')?.height).toBe(40)
  })

  it('says so when no other browser is showing', () => {
    mount()
    h.board.nodes = []
    refuse()
    fireEvent.click(screen.getByRole('button', { name: 'Hide another browser…' }))
    expect(screen.getByText('No other browser is showing on this board.')).toBeTruthy()
  })

  it('Try again re-attaches (with the profile) and shows progress until the next answer', () => {
    mount({ profileId: 'bp-0123456789ab' })
    refuse()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(h.state.attaches).toHaveLength(2)
    expect(h.state.attaches[1]).toMatchObject({ id: 'b1', profileId: 'bp-0123456789ab' })
    expect((screen.getByRole('button', { name: 'Trying again…' }) as HTMLButtonElement).disabled).toBe(true)
    refuse() // still full: a new error object ends the progress
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('input that cannot be forwarded gets feedback, not silence: nav is not sent and a warning explains', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'go' }))
    expect(h.state.sent.filter((m) => m.t === 'nav')).toHaveLength(1) // control: not paused yet, it is sent
    refuse()
    fireEvent.click(screen.getByRole('button', { name: 'go' }))
    expect(h.state.sent.filter((m) => m.t === 'nav')).toHaveLength(1)
    expect(h.showNotice).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ severity: 'warning', title: expect.stringContaining('paused') }))
  })

  it('the plate goes away by itself when the server wakes the node (a state arrives)', () => {
    mount()
    refuse()
    expect(screen.getByRole('alert', { name: 'Browser paused' })).toBeTruthy()
    msg(live)
    expect(screen.queryByRole('alert', { name: 'Browser paused' })).toBeNull()
  })
})
