/** @vitest-environment jsdom */
// Activity, Problems and Output are tabs of one bottom panel; Chat (with the Needs-you strip that
// replaced the Inbox) and Control are tabs of the Central secondary side bar on the right, behind ONE Dock icon (Central).
// Dock icons and status bar items highlight the SHOWN view
// (not merely open ones). Real AppDock + AppBottomPanel + SecondarySideBar.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Node } from '@xyflow/react'
import AppDock from './App.chrome'
import AppBottomPanel from './App.bottomPanel'
import SecondarySideBar from './App.secondarySideBar'
import { ACTIVITY_STATUS_ITEM } from './App.hooks'
import { revealBottomView } from './bottomPanelHost'
import type { CanvasViewport } from './canvasViewport'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { resetOutputStateForTest } from './output/outputCommands'
import { useOutputStatusItems } from './output/outputStatusItem'
import { useProblems } from './ProblemsPanel'
import { LEGACY_CENTRAL_OPEN_KEY, LEGACY_CHAT_OPEN_KEY, openCentralTab, reloadSideBarFromStorage, setSideBar } from './secondarySideBar.store'
import { setTimelineOpen } from './Timeline'
import { GATE, QUESTION } from './chat/needsYou.fixtures'
import { resetNeedsYou, useNeedsYouCount, type UnifiedItem } from './chat/needsYouApi'

const noop = () => {}
const VP: CanvasViewport = {
  zoom: 1, syncViewport: noop, onMoveEnd: noop, onFit: noop, onZoomIn: noop, onZoomOut: noop, onZoomTo: noop,
  onBack: noop, onForward: noop, canBack: false, canForward: false, resetViewport: noop,
}
const PROBLEMS = { problems: [], errors: 0, warnings: 0, running: false }
/** What `/api/approvals/inbox` lists (the Needs-you strip and the Chat badge). */
let waiting: UnifiedItem[] = []

beforeEach(() => {
  localStorage.clear()
  reloadSideBarFromStorage()
  revealBottomView(null)
  resetOutputStateForTest()
  setTimelineOpen(false)
  waiting = []
  resetNeedsYou()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(
    String(url).includes('problems') ? JSON.stringify(PROBLEMS) : String(url).startsWith('/api/approvals/inbox') ? JSON.stringify({ items: waiting }) : '[]')))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); reloadSideBarFromStorage() })

function App() {
  const nodesRef = useRef<Node[]>([])
  const problems = useProblems('ws1')
  const outputItems = useOutputStatusItems()
  return (
    <>
      <AppDock
        vp={VP} settings={DEFAULT_SETTINGS} activeWs={null} board={false} setBoard={noop}
        sideBar={{ open: false, view: 'layers', select: noop }} sessionsAttention={0} needsYouCount={useNeedsYouCount()}
        locked={false} setLocked={noop} cleanView={false}
        toggleCleanView={noop} setPicker={noop} setShowSettings={noop} onAddTerminal={noop} onAddAgent={noop}
        onCreateWorkspace={noop} onUndo={noop} onRedo={noop} canUndo={false} canRedo={false}
        extraStatusItems={[...problems.statusItems, ACTIVITY_STATUS_ITEM, ...outputItems]}
      />
      <AppBottomPanel problems={problems} nodes={[]} nodesRef={nodesRef}
        addFlowNode={noop} onFocus={noop} workspaces={[]} />
      <SecondarySideBar centralEnabled />
    </>
  )
}

const central = () => screen.getByRole('button', { name: /^Central(?! settings)/ })
const sideTab = (name: RegExp) => within(screen.getByRole('tablist', { name: 'Secondary Side Bar tabs' })).getByRole('tab', { name })

describe('Chat and Control in the secondary side bar', () => {
  it('the activity bar has one Central icon (no shield); it opens the side bar on Chat, tabs CHAT and CONTROL', async () => {
    render(<App />)
    expect(screen.getAllByRole('button', { name: /^Central(?! settings)/ })).toHaveLength(1)
    expect(document.querySelector('.dock .codicon-shield')).toBeNull()
    fireEvent.click(central())
    expect(document.querySelectorAll('.vscode-secondary-side-bar')).toHaveLength(1)
    expect(document.querySelector('.vscode-bottom-panel')).toBeNull()
    const tabs = within(screen.getByRole('tablist', { name: 'Secondary Side Bar tabs' })).getAllByRole('tab').map((t) => t.textContent)
    expect(tabs).toEqual(['Chat', 'Control'])
    expect(sideTab(/^Chat/).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(sideTab(/^Control/))
    expect(await screen.findByRole('tab', { name: 'Agents' })).toBeTruthy()
    for (const panel of document.querySelectorAll('.ccp-panel')) expect(panel.closest('.vscode-secondary-side-bar')).not.toBeNull()
  })

  it('Central icon: closed opens Chat, Control shown switches to Chat, Chat shown closes', () => {
    render(<App />)
    fireEvent.click(central())
    expect(sideTab(/^Chat/).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(sideTab(/^Control/))
    fireEvent.click(central()) // Control shown: switch, do not close
    expect(sideTab(/^Chat/).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(central()) // shown: close
    expect(document.querySelector('.vscode-secondary-side-bar')).toBeNull()
  })

  it('/status (and the other Control shortcuts) opens the side bar on the CONTROL header tab', async () => {
    render(<App />)
    act(() => openCentralTab('status')) // what the chat's /status runs
    expect(sideTab(/^Control/).getAttribute('aria-selected')).toBe('true')
    act(() => openCentralTab('abilities')) // /tools
    expect(sideTab(/^Control/).getAttribute('aria-selected')).toBe('true')
    expect(await screen.findByRole('tab', { name: 'Abilities' })).toBeTruthy()
  })

  it('a stored side bar on the old Central view falls back cleanly: it reopens on Control', () => {
    localStorage.setItem('webterm.secondarySideBar', JSON.stringify({ open: true, view: 'central' })) // test-only: pre-rename state
    reloadSideBarFromStorage()
    render(<App />)
    expect(sideTab(/^Control/).getAttribute('aria-selected')).toBe('true')
    expect(central().getAttribute('aria-current')).toBe('page')
    localStorage.setItem('webterm.secondarySideBar', JSON.stringify({ open: true, view: 'shield' })) // test-only: unknown view
    act(() => reloadSideBarFromStorage())
    expect(sideTab(/^Chat/).getAttribute('aria-selected')).toBe('true')
  })

  it('the bottom panel never lists Chat or Central, even for a user migrating with both open there', () => {
    localStorage.clear() // first run after the update: no side bar key yet
    localStorage.setItem(LEGACY_CHAT_OPEN_KEY, '1')
    localStorage.setItem(LEGACY_CENTRAL_OPEN_KEY, '1')
    reloadSideBarFromStorage()
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Activity timeline' }))
    const bottomTabs = within(screen.getByRole('tablist', { name: 'Panel tabs' })).getAllByRole('tab').map((t) => t.textContent)
    expect(bottomTabs).toEqual(['Activity'])
    expect(sideTab(/^Chat/).getAttribute('aria-selected')).toBe('true') // migrated into the side bar
    expect(sideTab(/^Control/)).toBeTruthy()
  })
})

describe('shown-view highlight', () => {
  it('lights the one Central icon while the side bar is open on either tab, and not once it is hidden', async () => {
    setSideBar({ open: true, view: 'central' })
    render(<App />)
    expect(sideTab(/^Control/).getAttribute('aria-selected')).toBe('true')
    expect(central().getAttribute('aria-current')).toBe('page') // open on Control: still lit
    expect(central().getAttribute('data-active')).toBe('true')
    fireEvent.click(sideTab(/^Chat/))
    expect(central().getAttribute('aria-current')).toBe('page')
    fireEvent.click(screen.getByRole('button', { name: 'Hide Secondary Side Bar' }))
    expect(central().getAttribute('aria-current')).toBeNull()
  })

  it('status bar Problems, Activity and Output items follow the shown view', async () => {
    render(<App />)
    const problems = await screen.findByRole('button', { name: /^Problems:/ })
    const activity = screen.getByRole('button', { name: 'Toggle Activity timeline' })
    const output = screen.getAllByRole('button', { name: /^Toggle Output/ })[0]
    expect([problems, activity, output].map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false'])
    fireEvent.click(activity)
    expect(activity.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(problems)
    expect(problems.getAttribute('aria-pressed')).toBe('true')
    expect(activity.getAttribute('aria-pressed')).toBe('false') // open, hidden behind Problems
    fireEvent.click(output)
    expect(output.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(activity) // hidden: reveal
    expect(activity.getAttribute('aria-pressed')).toBe('true')
    expect(output.getAttribute('aria-pressed')).toBe('false')
  })
})

describe('Needs-you replaces the Inbox', () => {
  it('the activity bar has no Inbox icon; the Central icon badges what waits', async () => {
    waiting = [GATE, QUESTION]
    render(<App />)
    expect(screen.queryByRole('button', { name: /inbox/i })).toBeNull()
    expect(await screen.findByRole('button', { name: 'Central, 2' })).toBeTruthy()
  })

  it('with items waiting, the Central icon opens the side bar on Chat with the strip expanded', async () => {
    waiting = [GATE]
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Central, 1' }))
    expect(sideTab(/^Chat/).getAttribute('aria-selected')).toBe('true')
    const head = await screen.findByRole('button', { name: /1 needs you/ })
    expect(head.getAttribute('aria-expanded')).toBe('true')
    expect(await screen.findByText('Run migration')).toBeTruthy()
    fireEvent.click(central()) // shown: the icon closes it again
    expect(document.querySelector('.vscode-secondary-side-bar')).toBeNull()
  })

  it('with nothing waiting, the Central icon is a plain toggle without a badge', async () => {
    render(<App />)
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).startsWith('/api/approvals/inbox'))).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'Central' }))
    expect(sideTab(/^Chat/).getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByRole('button', { name: /needs? you/ })).toBeNull()
  })

  it('a stored open Inbox (webterm.inboxOpen) falls back to no bottom panel and no Inbox tab', () => {
    localStorage.setItem('webterm.inboxOpen', '1') // test-only: the removed panel's old key
    render(<App />)
    expect(document.querySelector('.vscode-bottom-panel')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Activity timeline' }))
    const bottomTabs = within(screen.getByRole('tablist', { name: 'Panel tabs' })).getAllByRole('tab').map((t) => t.textContent)
    expect(bottomTabs).toEqual(['Activity'])
  })
})
