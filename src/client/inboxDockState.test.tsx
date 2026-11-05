/**
 * @vitest-environment jsdom
 */
// Jembatan Dock → Inbox. Yang dijaga di sini adalah hal-hal yang tidak terlihat dari tsc:
//   1. Badge hanya ANGKA dari `GET /api/inbox`; dock tidak pernah menyetujui apa pun dan tidak
//      pernah memanggil `fetch` sendiri.
//   2. Hanya SATU poller pada satu waktu: badge menyemai angkanya sekali saat mount (termasuk
//      saat panel terbuka, supaya badge ada sejak boot) lalu hanya polling saat panel tertutup.
//      Selama panel terbuka, panel yang mempublikasikan angkanya lewat `publishInboxCount`.
//   3. Panel yang tertutup tidak memuat apa pun.
//   4. `i` membuka inbox, tapi bukan saat fokus ada di kolom teks/terminal.
import { readFileSync } from 'node:fs'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import Dock, { type DockProps } from './Dock'
import InboxPanel from './InboxPanel'
import type { InboxClient, InboxItem } from './inboxApi'
import {
  INBOX_POLL_MS,
  formatInboxBadge,
  inboxUnread,
  isTypingTarget,
  publishInboxCount,
  useInboxBadge,
  useInboxHotkey,
  type InboxBadgeOptions,
} from './inboxDockState'
import { installCanvasDom, mountCanvas, unmountCanvas } from './canvasHarness'

const ITEMS: InboxItem[] = [
  { id: 'i1', kind: 'deploy', state: 'needs_you', projectId: 'proj-a', title: 'Deploy main', ageMs: 1_000 },
  { id: 'i2', kind: 'rotate', state: 'needs_you', projectId: 'proj-a', title: 'Rotate keys', ageMs: 2_000 },
  { id: 'i3', kind: 'review', state: 'review', projectId: 'proj-b', title: 'Read diff', ageMs: 3_000 },
  { id: 'i4', kind: 'ci', state: 'broken', projectId: 'proj-b', title: 'CI failed', ageMs: 4_000 },
]

function fakeClient(listInbox: InboxClient['listInbox'] = vi.fn(async () => ITEMS)): InboxClient {
  return {
    listInbox,
    getApprovalChallenge: vi.fn(),
    requestApproval: vi.fn(),
    decideApproval: vi.fn(),
    consumeApproval: vi.fn(),
  }
}

function BadgeProbe(props: InboxBadgeOptions) {
  return <span data-testid="badge">{useInboxBadge(props)}</span>
}

function HotkeyProbe({ onToggle, enabled }: { onToggle: () => void; enabled?: boolean }) {
  useInboxHotkey(onToggle, enabled)
  return <input data-testid="field" />
}

function PanelAndBadge({ client }: { client: InboxClient }) {
  return (
    <>
      <InboxPanel open client={client} />
      <BadgeProbe panelOpen client={client} />
    </>
  )
}

function dockProps(over: Partial<DockProps> = {}): DockProps {
  return {
    onAddTerminal: () => {},
    onAddAgent: () => {},
    onCreateWorkspace: () => {},
    onBrowse: () => {},
    onUndo: () => {},
    onRedo: () => {},
    canUndo: false,
    canRedo: false,
    onBack: () => {},
    onForward: () => {},
    canBack: false,
    canForward: false,
    onFit: () => {},
    onToggleBoard: () => {},
    sessionsOpen: false,
    onToggleSessions: () => {},
    inboxOpen: false,
    onToggleInbox: () => {},
    zoomPct: 100,
    onZoomIn: () => {},
    onZoomOut: () => {},
    locked: false,
    onToggleLock: () => {},
    cleanView: false,
    onToggleCleanView: () => {},
    ...over,
  }
}

/** Delegasi mikro-task, termasuk `.then` dari client palsu. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  publishInboxCount(null)
})

describe('pure helpers', () => {
  it('counts every listed item and caps the badge at three digits', () => {
    expect(inboxUnread(ITEMS)).toBe(4)
    expect(inboxUnread([])).toBe(0)
    expect(formatInboxBadge(0)).toBe('')
    expect(formatInboxBadge(-1)).toBe('')
    expect(formatInboxBadge(1)).toBe('1')
    expect(formatInboxBadge(99)).toBe('99')
    expect(formatInboxBadge(120)).toBe('99+')
  })

  it('treats text fields and contenteditable as typing targets', () => {
    expect(isTypingTarget(document.createElement('input'))).toBe(true)
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true)
    expect(isTypingTarget(document.createElement('select'))).toBe(true)
    expect(isTypingTarget(document.createElement('button'))).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})

describe('badge hook', () => {
  it('loads the count once on mount while the panel is closed', async () => {
    const client = fakeClient()
    render(<BadgeProbe panelOpen={false} client={client} />)
    await flush()
    expect(screen.getByTestId('badge').textContent).toBe('4')
    expect(client.listInbox).toHaveBeenCalledTimes(1)
  })

  it('polls every 30s while closed', async () => {
    vi.useFakeTimers()
    const client = fakeClient()
    render(<BadgeProbe panelOpen={false} client={client} />)
    await flush()
    expect(client.listInbox).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(INBOX_POLL_MS)
    })
    expect(client.listInbox).toHaveBeenCalledTimes(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(INBOX_POLL_MS)
    })
    expect(client.listInbox).toHaveBeenCalledTimes(3)
  })

  it('seeds the count on boot while the panel is open, then never polls', async () => {
    vi.useFakeTimers()
    const client = fakeClient()
    render(<BadgeProbe panelOpen client={client} />)
    await flush()
    expect(client.listInbox).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('badge').textContent).toBe('4')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(INBOX_POLL_MS * 3)
    })
    expect(client.listInbox).toHaveBeenCalledTimes(1)
  })

  it('follows the count published by the open panel without a second fetch', async () => {
    const client = fakeClient()
    render(<BadgeProbe panelOpen client={client} />)
    await flush()
    expect(screen.getByTestId('badge').textContent).toBe('4')

    act(() => publishInboxCount(2))
    expect(screen.getByTestId('badge').textContent).toBe('2')

    // A closed panel publishes null; the badge falls back to its own last count.
    act(() => publishInboxCount(null))
    expect(screen.getByTestId('badge').textContent).toBe('4')
    expect(client.listInbox).toHaveBeenCalledTimes(1)
  })

  it('feeds the badge from the open panel across a refresh', async () => {
    let items = ITEMS
    const client = fakeClient(vi.fn(async () => items))
    render(<PanelAndBadge client={client} />)
    await flush()
    expect(screen.getByTestId('badge').textContent).toBe('4')

    items = []
    fireEvent.click(screen.getByRole('button', { name: 'Refresh inbox' }))
    await waitFor(() => expect(screen.getByTestId('badge').textContent).toBe('0'))
    expect(screen.getByText('Inbox is clear.')).toBeDefined()
  })

  it('does not overlap its own requests', async () => {
    vi.useFakeTimers()
    const listInbox = vi.fn<InboxClient['listInbox']>(() => new Promise<InboxItem[]>(() => {}))
    render(<BadgeProbe panelOpen={false} client={fakeClient(listInbox)} />)
    await flush()
    expect(listInbox).toHaveBeenCalledTimes(1)

    // Tiga interval lewat, tapi request pertama belum pernah selesai: tidak ada yang menumpuk.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INBOX_POLL_MS * 3)
    })
    expect(listInbox).toHaveBeenCalledTimes(1)
  })

  it('does not fetch in a hidden tab', async () => {
    const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    try {
      const client = fakeClient()
      render(<BadgeProbe panelOpen={false} client={client} />)
      await flush()
      expect(client.listInbox).not.toHaveBeenCalled()
    } finally {
      if (visibility) Object.defineProperty(document, 'visibilityState', visibility)
    }
  })

  it('does nothing before the board is hydrated', async () => {
    const client = fakeClient()
    render(<BadgeProbe panelOpen={false} enabled={false} client={client} />)
    await flush()
    expect(client.listInbox).not.toHaveBeenCalled()
  })
})

describe('Dock inbox button', () => {
  it('shows the badge and toggles without fetching or approving anything', () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const onToggleInbox = vi.fn()
    render(<Dock {...dockProps({ inboxUnread: 4, onToggleInbox })} />)

    const button = screen.getByRole('button', { name: 'Toggle inbox panel, 4' })
    expect(button.getAttribute('aria-current')).toBeNull()
    const badge = button.querySelector('.vscode-activity-bar__badge')
    expect(badge?.textContent).toBe('4')
    // Badge dekoratif: pembaca layar sudah menerima angkanya dari aria-label tombol.
    expect(badge?.getAttribute('aria-hidden')).toBe('true')

    fireEvent.click(button)
    expect(onToggleInbox).toHaveBeenCalledTimes(1)
    // Klik badge adalah buka/tutup, bukan persetujuan — tidak ada lalu lintas jaringan sama sekali.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('reflects the open state and drops the badge at zero', () => {
    const { rerender } = render(<Dock {...dockProps({ inboxOpen: true, inboxUnread: 0 })} />)
    const button = screen.getByRole('button', { name: 'Toggle inbox panel' })
    expect(button.getAttribute('aria-current')).toBe('page')
    expect(button.querySelector('.vscode-activity-bar__badge')).toBeNull()

    rerender(<Dock {...dockProps({ inboxOpen: false, inboxUnread: 120 })} />)
    expect(screen.getByRole('button', { name: 'Toggle inbox panel, 99+' }).querySelector('.vscode-activity-bar__badge')?.textContent).toBe('99+')
  })
})

describe('closed panel', () => {
  it('never fetches while open={false}', async () => {
    const client = fakeClient()
    const view = render(<InboxPanel open={false} client={client} />)
    await flush()
    expect(client.listInbox).not.toHaveBeenCalled()
    expect(view.container.firstChild).toBeNull()
  })
})

describe('hotkey', () => {
  it('toggles on plain i, but not from a text field or with a modifier', () => {
    const onToggle = vi.fn()
    render(<HotkeyProbe onToggle={onToggle} />)
    fireEvent.keyDown(document.body, { key: 'i' })
    expect(onToggle).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(screen.getByTestId('field'), { key: 'i' })
    fireEvent.keyDown(document.body, { key: 'i', metaKey: true })
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('does not yank the panel out from under an open dialog', () => {
    const onToggle = vi.fn()
    render(<HotkeyProbe onToggle={onToggle} />)
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.appendChild(dialog)
    try {
      fireEvent.keyDown(document.body, { key: 'i' })
      expect(onToggle).not.toHaveBeenCalled()
    } finally {
      dialog.remove()
    }
  })
})

// Inbox is a tab of the single bottom panel now, so "mounted" means its tab exists in that strip.
const inboxTab = (): HTMLElement | null => {
  const strip = screen.queryByRole('tablist', { name: 'Panel tabs' })
  return strip ? within(strip).queryByRole('tab', { name: /^Inbox/ }) : null
}

describe('App wiring', () => {
  beforeAll(installCanvasDom)
  afterEach(() => {
    unmountCanvas()
    localStorage.clear()
  })

  it('dock button and i toggle the real InboxPanel mounted by App', async () => {
    await mountCanvas({ nodes: [], dirs: {} })

    // `useInboxOpen` default terbuka, sama seperti panel Sessions.
    expect(inboxTab()).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /^Toggle inbox panel/ }))
    await waitFor(() => expect(inboxTab()).toBeNull())

    fireEvent.keyDown(document.body, { key: 'i' })
    await waitFor(() => expect(inboxTab()).not.toBeNull())
  })
})

describe('activity bar badge contract', () => {
  it('badge is absolutely anchored and does not eat clicks', () => {
    const css = readFileSync('src/client/components/vscode/vscode-shell.css', 'utf8')
    const block = /\.vscode-activity-bar__badge\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(block).toContain('position: absolute')
    expect(block).toContain('right:')
    expect(block).toContain('bottom:')
  })
})
