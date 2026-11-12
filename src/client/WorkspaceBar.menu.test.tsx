/** @vitest-environment jsdom */
// WorkspaceBar title bar: File > New Files Node and the command center (opens the omnibox,
// shows its Mod+K chord). These replaced the floating canvas toolbar.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import WorkspaceBar, { type WorkspaceBarProps } from './WorkspaceBar'
import { registerCommands } from './commandRegistry'
import { isMacPlatform } from './terminalKeys'
import { openSetup } from './setup/setup.open'
import { DEFAULT_VIEWPORT, type Workspace } from '../shared/workspace'

vi.mock('./setup/setup.open', () => ({ openSetup: vi.fn() }))

const ws: Workspace = { id: 'w1', name: 'Proj', cwd: '/proj', viewport: DEFAULT_VIEWPORT, nodes: [], bridges: [], updatedAt: 0 } // test-only

let unregister: () => void
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ managed: false }))))
  unregister = registerCommands([{ id: 'workbench.omnibox', label: 'Go to Anything', defaultKey: 'Mod+K', run: () => {}, hidden: true }])
})
afterEach(() => { cleanup(); unregister(); vi.unstubAllGlobals() })

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
    fireEvent.click(screen.getByRole('menuitem', { name: 'File' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'New Files Node' }))
    expect(onNewFiles).toHaveBeenCalledTimes(1)
  })

  it('is absent without an open workspace', () => {
    mount({ onNewFiles: vi.fn(), workspaces: [], activeId: null, liveActiveNodes: null })
    fireEvent.click(screen.getByRole('menuitem', { name: 'File' }))
    expect(screen.queryByRole('menuitem', { name: 'New Files Node' })).toBeNull()
  })
})

describe('Account and Sign out', () => {
  it('the title-bar Account button opens the account menu (not Settings); File has Account… and Sign out', () => {
    const onOpenAccount = vi.fn()
    const onLogout = vi.fn()
    mount({ showLogout: true, onOpenAccount, onLogout })
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Account' }), { button: 0, ctrlKey: false, pointerType: 'mouse' })
    expect(onOpenAccount).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Account settings' }))
    expect(onOpenAccount).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('menuitem', { name: 'File' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }))
    expect(onLogout).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('menuitem', { name: 'File' }))
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'View' }))
    expect(screen.getByRole('menuitem', { name: 'Clear Output' })).toBeTruthy()
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Show Node Tabs' })).toBeNull()
    expect(screen.queryByText('Show Node Tabs')).toBeNull()
  })
})

describe('title bar command center', () => {
  it('shows the Mod+K chord and opens the palette on click', () => {
    const onOpenPalette = vi.fn()
    mount({ onOpenPalette })
    const search = screen.getByRole('button', { name: 'Search' })
    expect(search.textContent).toContain('Proj')
    expect(search.querySelector('.kbd')?.textContent).toBe(isMacPlatform() ? '⌘K' : 'Ctrl+K')
    fireEvent.click(search)
    expect(onOpenPalette).toHaveBeenCalledTimes(1)
  })
})

describe('Help > Set up webterm…', () => {
  it('opens the setup wizard', () => {
    vi.mocked(openSetup).mockClear()
    mount({ onOpenHelp: vi.fn() })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Help' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Set up webterm…' }))
    expect(openSetup).toHaveBeenCalledTimes(1)
  })
})

describe('tab-row actions without a workspace', () => {
  it('hides the layout toggle (not disabled); keeps +, search and Account', () => {
    mount({ workspaces: [], activeId: null, liveActiveNodes: null, onToggleLayout: vi.fn(), onOpenPalette: vi.fn(), showLogout: true, onOpenAccount: vi.fn() })
    expect(screen.queryByRole('button', { name: 'Toggle tab layout' })).toBeNull()
    for (const name of ['New workspace', 'Search', 'Account']) expect(screen.getByRole('button', { name })).toBeTruthy()
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
