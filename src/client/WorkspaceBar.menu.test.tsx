/** @vitest-environment jsdom */
// WorkspaceBar menu rows and the tab row's own controls. Without a rail on screen (these tests mount the bar alone) the
// row carries the menu button; the same menu is the rail's hamburger in the app (headerRail.inventory.test.tsx).
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import WorkspaceBar, { type WorkspaceBarProps } from './WorkspaceBar'
import { openSetup } from './setup/setup.open'
import { DEFAULT_VIEWPORT, type Workspace } from '../shared/workspace'

vi.mock('./setup/setup.open', () => ({ openSetup: vi.fn() }))

const ws: Workspace = { id: 'w1', name: 'Proj', cwd: '/proj', viewport: DEFAULT_VIEWPORT, nodes: [], bridges: [], updatedAt: 0 } // test-only

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ managed: false }))))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/** Opens the app menu, then a top-level menu of it (File / View / Help). */
const openTop = (name: string): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
  fireEvent.click(screen.getByRole('menuitem', { name }))
}

function mount(over: Partial<WorkspaceBarProps> = {}) {
  render(
    <WorkspaceBar
      workspaces={[ws]} activeId="w1" liveActiveNodes={[]} statuses={{}}
      onSelect={vi.fn()} onNewWorkspace={vi.fn()} onRenameWorkspace={vi.fn()} onDeleteWorkspace={vi.fn()}
      {...over}
    />,
  )
}

describe('File > New Files Node', () => {
  it('is in the File menu and runs onNewFiles', () => {
    const onNewFiles = vi.fn()
    mount({ onNewFiles })
    openTop('File')
    fireEvent.click(screen.getByRole('menuitem', { name: 'New Files Node' }))
    expect(onNewFiles).toHaveBeenCalledTimes(1)
  })

  it('is absent without an open workspace', () => {
    mount({ onNewFiles: vi.fn(), workspaces: [], activeId: null, liveActiveNodes: null })
    openTop('File')
    expect(screen.queryByRole('menuitem', { name: 'New Files Node' })).toBeNull()
  })
})

describe('Account and Sign out', () => {
  it('the row\'s Account button opens the account menu (not Settings); File has Account… and Sign out', () => {
    const onOpenAccount = vi.fn()
    const onLogout = vi.fn()
    mount({ showLogout: true, onOpenAccount, onLogout })
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Account' }), { button: 0, ctrlKey: false, pointerType: 'mouse' })
    expect(onOpenAccount).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Account settings' }))
    expect(onOpenAccount).toHaveBeenCalledTimes(1)
    openTop('File')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }))
    expect(onLogout).toHaveBeenCalledTimes(1)
    openTop('File')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Account…' }))
    expect(onOpenAccount).toHaveBeenCalledTimes(2)
  })

  it('hidden while this browser holds no session', () => {
    mount({ showLogout: false, onOpenAccount: vi.fn(), onLogout: vi.fn() })
    expect(screen.queryByRole('button', { name: 'Account' })).toBeNull()
  })
})

describe('View menu', () => {
  // Policy: the node tab strip moved into the Layers side bar, so its toggle is gone for good.
  it('has no Show Node Tabs item', () => {
    mount()
    openTop('View')
    expect(screen.getByRole('menuitem', { name: 'Clear Output' })).toBeTruthy()
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Show Node Tabs' })).toBeNull()
    expect(screen.queryByText('Show Node Tabs')).toBeNull()
  })
})

describe('Help > Set up webterm…', () => {
  it('opens the setup wizard', () => {
    vi.mocked(openSetup).mockClear()
    mount({ onOpenHelp: vi.fn() })
    openTop('Help')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Set up webterm…' }))
    expect(openSetup).toHaveBeenCalledTimes(1)
  })
})

describe('tab-row actions without a workspace', () => {
  it('hides the layout toggle (not disabled); keeps +, the menu and Account', () => {
    mount({ workspaces: [], activeId: null, liveActiveNodes: null, onToggleLayout: vi.fn(), showLogout: true, onOpenAccount: vi.fn() })
    expect(screen.queryByRole('button', { name: 'Toggle tab layout' })).toBeNull()
    for (const name of ['New workspace', 'Menu', 'Account']) expect(screen.getByRole('button', { name })).toBeTruthy()
  })

  it('shows the layout toggle, enabled, with a workspace open', () => {
    mount({ onToggleLayout: vi.fn() })
    expect((screen.getByRole('button', { name: 'Toggle tab layout' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('Workspace tab context menu', () => {
  const openMenu = () => fireEvent.contextMenu(screen.getByRole('tab', { name: /Proj/ }), { clientX: 10, clientY: 10 })

  it('Mute Notifications mutes this workspace and the row then offers Unmute', async () => {
    const { readNotifyPrefs, setWorkspaceMuted } = await import('./osNotify.prefs')
    setWorkspaceMuted('w1', false)
    mount()
    openMenu()
    fireEvent.click(await screen.findByText('Mute Notifications'))
    expect(readNotifyPrefs().muted).toContain('w1')
    openMenu()
    fireEvent.click(await screen.findByText('Unmute Notifications'))
    expect(readNotifyPrefs().muted).not.toContain('w1')
  })

  it('Canvas Background… opens Settings › Appearance on the canvas background', async () => {
    const { OPEN_SETTINGS_EVENT } = await import('./settings.link')
    const seen = vi.fn()
    window.addEventListener(OPEN_SETTINGS_EVENT, seen)
    mount()
    openMenu()
    fireEvent.click(await screen.findByText('Canvas Background…'))
    expect((seen.mock.calls[0][0] as CustomEvent).detail).toEqual({ section: 'appearance', field: 'canvasBackground' })
    window.removeEventListener(OPEN_SETTINGS_EVENT, seen)
  })
})
