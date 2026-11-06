/**
 * @vitest-environment jsdom
 *
 * Drives the real wiring: `./unread#noteStatus` (what the socket calls) → `./osNotify` gate →
 * mocked `Notification`. Workspaces come from a mocked `fetchWorkspaces`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

vi.mock('./api', () => ({
  fetchWorkspaces: vi.fn(async () => [
    { id: 'wsA', name: 'Alpha', nodes: [{ id: 'n1', agentId: 'claude' }, { id: 'n2', title: 'Reviewer' }, { id: 'n3' }] },
    { id: 'wsB', name: 'Beta', nodes: [{ id: 'm1', agentId: 'codex' }] },
  ]),
}))

class FakeNotification {
  static permission: NotificationPermission = 'granted'
  static requestPermission = vi.fn(async () => 'granted' as NotificationPermission)
  static shown: FakeNotification[] = []
  onclick: (() => void) | null = null
  close = vi.fn()
  constructor(public title: string, public opts: NotificationOptions) {
    FakeNotification.shown.push(this)
  }
}

let visibility: DocumentVisibilityState = 'hidden'
let focused = false

async function load() {
  vi.resetModules()
  const unread = await import('./unread')
  const osNotify = await import('./osNotify')
  const prefs = await import('./osNotify.prefs')
  return { ...unread, ...osNotify, ...prefs }
}

/** Working → ended: a real transition, which is what notifies. */
function endTurn(noteStatus: (id: string, s: 'working' | 'done' | 'waiting') => void, id: string, s: 'done' | 'waiting' = 'done') {
  noteStatus(id, 'working')
  noteStatus(id, s)
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  localStorage.setItem('webterm.osNotify', JSON.stringify({ sound: false }))
  FakeNotification.permission = 'granted'
  FakeNotification.shown = []
  FakeNotification.requestPermission.mockClear()
  vi.stubGlobal('Notification', FakeNotification)
  visibility = 'hidden'
  focused = false
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('osNotify', () => {
  it('hidden tab + turn ends → exactly one notification naming agent and workspace', async () => {
    const { noteStatus, COALESCE_MS } = await load()
    endTurn(noteStatus, 'n1')
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    expect(FakeNotification.shown).toHaveLength(1)
    expect(FakeNotification.shown[0].title).toBe('Claude Code finished')
    expect(FakeNotification.shown[0].opts.body).toBe('in Alpha')
  })

  it('needs-input wording for waiting', async () => {
    const { noteStatus, COALESCE_MS } = await load()
    endTurn(noteStatus, 'n2', 'waiting')
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    expect(FakeNotification.shown[0].title).toBe('Reviewer needs input')
  })

  it('visible, focused tab and the watched node → no notification', async () => {
    const { noteStatus, watchNode, COALESCE_MS } = await load()
    visibility = 'visible'
    focused = true
    watchNode('n1')
    endTurn(noteStatus, 'n1')
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    expect(FakeNotification.shown).toHaveLength(0)
  })

  it('focused tab: node on screen is suppressed, node off screen notifies', async () => {
    const { noteStatus, setNotifyCanvas, COALESCE_MS } = await load()
    visibility = 'visible'
    focused = true
    setNotifyCanvas({ focus: vi.fn(), inView: (id) => id === 'n1' })
    endTurn(noteStatus, 'n1')
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    expect(FakeNotification.shown).toHaveLength(0)
    endTurn(noteStatus, 'm1')
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    expect(FakeNotification.shown).toHaveLength(1)
  })

  it('status replay on (re)attach is not news: first sighting and repeats stay silent', async () => {
    const { noteStatus, COALESCE_MS } = await load()
    noteStatus('n1', 'done')
    noteStatus('n1', 'done')
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    expect(FakeNotification.shown).toHaveLength(0)
  })

  it('coalesces a burst into one banner with a shared tag', async () => {
    const { noteStatus, COALESCE_MS } = await load()
    endTurn(noteStatus, 'n1')
    endTurn(noteStatus, 'n2', 'waiting')
    endTurn(noteStatus, 'm1')
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    expect(FakeNotification.shown).toHaveLength(1)
    expect(FakeNotification.shown[0].title).toBe('3 agents need attention')
    expect(FakeNotification.shown[0].opts.body).toBe('Claude Code finished\nReviewer needs input\nCodex finished')
    expect(FakeNotification.shown[0].opts.tag).toBe('webterm-attention')
  })

  it('muted workspace gets neither banner nor sound; others still notify', async () => {
    const chimes = vi.fn()
    vi.stubGlobal('AudioContext', class {
      currentTime = 0
      destination = {}
      resume = vi.fn(async () => {})
      createGain = () => ({ connect: vi.fn(), gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() } })
      createOscillator = () => ({ connect: vi.fn(), frequency: { setValueAtTime: vi.fn() }, start: chimes, stop: vi.fn() })
    })
    const { noteStatus, setWorkspaceMuted, writeNotifyPrefs, COALESCE_MS } = await load()
    writeNotifyPrefs({ sound: true })
    setWorkspaceMuted('wsA', true)
    endTurn(noteStatus, 'n1')
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    expect(FakeNotification.shown).toHaveLength(0)
    expect(chimes).not.toHaveBeenCalled()
    endTurn(noteStatus, 'm1')
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    expect(FakeNotification.shown).toHaveLength(1)
    expect(chimes).toHaveBeenCalledTimes(1)
  })

  it('disabled in Settings → no banner', async () => {
    const { noteStatus, writeNotifyPrefs, COALESCE_MS } = await load()
    writeNotifyPrefs({ enabled: false })
    endTurn(noteStatus, 'n1')
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    expect(FakeNotification.shown).toHaveLength(0)
  })

  it('hooks from different owners merge; uninstall removes only its own key', async () => {
    const { setNotifyCanvas, noteStatus, COALESCE_MS } = await load()
    visibility = 'visible'
    focused = true
    const focus = vi.fn()
    setNotifyCanvas({ inView: () => true })
    const offFocus = setNotifyCanvas({ focus })
    offFocus()
    // inView survived the focus uninstall → on-screen node still suppressed.
    endTurn(noteStatus, 'n1')
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    expect(FakeNotification.shown).toHaveLength(0)
  })

  it('click focuses the tab and flies to the node', async () => {
    const focus = vi.fn()
    const winFocus = vi.spyOn(window, 'focus').mockImplementation(() => {})
    const { noteStatus, setNotifyCanvas, COALESCE_MS } = await load()
    setNotifyCanvas({ focus, inView: () => false })
    endTurn(noteStatus, 'n2')
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    FakeNotification.shown[0].onclick?.()
    expect(winFocus).toHaveBeenCalled()
    expect(focus).toHaveBeenCalledWith('n2')
    expect(FakeNotification.shown[0].close).toHaveBeenCalled()
  })

  it('permission not yet decided → visible in-app prompt; Allow requests permission', async () => {
    FakeNotification.permission = 'default'
    const { noteStatus, COALESCE_MS } = await load()
    // Warm the module the gate lazy-imports: a cold transform + load of it can outlast `vi.waitFor`'s
    // window on a loaded machine. The gate's own `import()` still runs; it just resolves from cache.
    await import('./osNotify.prompt')
    endTurn(noteStatus, 'n1')
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    await vi.waitFor(() => expect(screen.getByText('An agent needs your attention')).toBeTruthy())
    expect(FakeNotification.shown).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1)
  })
})

describe('tab badge', () => {
  it('title and favicon carry the unread count', async () => {
    const { markUnread, clearUnread } = await load()
    markUnread('a')
    markUnread('b')
    expect(document.title).toBe('(2) webterm')
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')!
    expect(decodeURIComponent(icon.href)).toContain('>2</text>')
    clearUnread('a')
    clearUnread('b')
    expect(document.title).toBe('webterm')
    expect(decodeURIComponent(icon.href)).not.toContain('</text>')
  })
})

describe('Settings rows', () => {
  it('re-enabling with undecided permission asks the browser; mute row per workspace persists', async () => {
    vi.useRealTimers()
    FakeNotification.permission = 'default'
    const { readNotifyPrefs } = await load()
    const { NotificationRows } = await import('./osNotify.settings')
    render(<NotificationRows />)
    const toggle = screen.getByLabelText('Desktop notifications') as HTMLInputElement
    expect(toggle.checked).toBe(true)
    fireEvent.click(toggle)
    expect(readNotifyPrefs().enabled).toBe(false)
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled()
    fireEvent.click(toggle)
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1)
    fireEvent.click(await screen.findByLabelText('Mute notifications: Beta'))
    expect(readNotifyPrefs().muted).toEqual(['wsB'])
  })
})
