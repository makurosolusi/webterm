/** @vitest-environment jsdom */
// Inbox, Activity, Problems and Output are tabs of one bottom panel; Chat and Central are tabs of
// the secondary side bar on the right. Dock icons and status bar items highlight the SHOWN view
// (not merely open ones). Real AppDock + AppBottomPanel + SecondarySideBar.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useRef, useState } from 'react'
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
import { LEGACY_CENTRAL_OPEN_KEY, LEGACY_CHAT_OPEN_KEY, reloadSideBarFromStorage, setSideBar } from './secondarySideBar.store'
import { setTimelineOpen } from './Timeline'

const noop = () => {}
const VP: CanvasViewport = {
  zoom: 1, syncViewport: noop, onMoveEnd: noop, onFit: noop, onZoomIn: noop, onZoomOut: noop, onZoomTo: noop,
  onBack: noop, onForward: noop, canBack: false, canForward: false, resetViewport: noop,
}
const PROBLEMS = { problems: [], errors: 0, warnings: 0, running: false }

beforeEach(() => {
  localStorage.clear()
  reloadSideBarFromStorage()
  revealBottomView(null)
  resetOutputStateForTest()
  setTimelineOpen(false)
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(String(url).includes('problems') ? JSON.stringify(PROBLEMS) : '[]')))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); reloadSideBarFromStorage() })

function App() {
  const [inboxOpen, setInboxOpen] = useState(false)
  const nodesRef = useRef<Node[]>([])
  const problems = useProblems('ws1')
  const outputItems = useOutputStatusItems()
  return (
    <>
      <AppDock
        vp={VP} settings={DEFAULT_SETTINGS} activeWs={null} centralEnabled board={false} setBoard={noop}
        sessionsOpen={false} setSessionsOpen={noop} inboxOpen={inboxOpen} setInboxOpen={setInboxOpen}
        locked={false} setLocked={noop} cleanView={false}
        toggleCleanView={noop} setPicker={noop} setShowSettings={noop} onAddTerminal={noop} onAddAgent={noop}
        onCreateWorkspace={noop} onUndo={noop} onRedo={noop} canUndo={false} canRedo={false}
        extraStatusItems={[...problems.statusItems, ACTIVITY_STATUS_ITEM, ...outputItems]}
      />
      <AppBottomPanel inboxOpen={inboxOpen} setInboxOpen={setInboxOpen} problems={problems} nodes={[]} nodesRef={nodesRef}
        addFlowNode={noop} onFocus={noop} workspaces={[]} />
      <SecondarySideBar centralEnabled />
    </>
  )
}

const central = () => screen.getByRole('button', { name: 'Toggle central control panel' })
const chat = () => screen.getByRole('button', { name: 'Toggle chat panel' })
const inbox = () => screen.getByRole('button', { name: /^Toggle inbox panel/ })
const sideTab = (name: RegExp) => within(screen.getByRole('tablist', { name: 'Secondary Side Bar tabs' })).getByRole('tab', { name })
const shownTab = () => [...document.querySelectorAll('[role=tab][aria-selected=true]')].map((t) => t.textContent).join()

describe('Chat and Central in the secondary side bar', () => {
  it('the Dock Central icon opens the side bar on its tab, not a bottom panel tab', async () => {
    render(<App />)
    fireEvent.click(central())
    expect(await screen.findByRole('tab', { name: 'Control' })).toBeTruthy()
    expect(document.querySelectorAll('.vscode-secondary-side-bar')).toHaveLength(1)
    expect(document.querySelector('.vscode-bottom-panel')).toBeNull()
    expect(sideTab(/^Chat/)).toBeTruthy()
    expect(sideTab(/^Central/).getAttribute('aria-selected')).toBe('true')
    for (const panel of document.querySelectorAll('.ccp-panel')) expect(panel.closest('.vscode-secondary-side-bar')).not.toBeNull()
  })

  it('Dock toggle: closed opens the tab, the other tab shown switches, the shown tab closes', () => {
    render(<App />)
    fireEvent.click(chat())
    expect(sideTab(/^Chat/).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(central()) // side bar shows Chat: switch, do not close
    expect(sideTab(/^Central/).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(chat())
    expect(sideTab(/^Chat/).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(chat()) // shown: close
    expect(document.querySelector('.vscode-secondary-side-bar')).toBeNull()
  })

  it('the bottom panel never lists Chat or Central, even for a user migrating with both open there', () => {
    localStorage.clear() // first run after the update: no side bar key yet
    localStorage.setItem(LEGACY_CHAT_OPEN_KEY, '1')
    localStorage.setItem(LEGACY_CENTRAL_OPEN_KEY, '1')
    reloadSideBarFromStorage()
    render(<App />)
    fireEvent.click(inbox())
    const bottomTabs = within(screen.getByRole('tablist', { name: 'Panel tabs' })).getAllByRole('tab').map((t) => t.textContent)
    expect(bottomTabs).toEqual(['Inbox'])
    expect(sideTab(/^Chat/).getAttribute('aria-selected')).toBe('true') // migrated into the side bar
    expect(sideTab(/^Central/)).toBeTruthy()
  })
})

describe('shown-view highlight', () => {
  it('highlights the Dock icon of the side bar view shown, and follows tab switches', async () => {
    setSideBar({ open: true, view: 'central' })
    render(<App />)
    expect(shownTab()).toMatch(/^Central/)
    expect(central().getAttribute('aria-current')).toBe('page')
    expect(chat().getAttribute('aria-current')).toBeNull()
    fireEvent.click(sideTab(/^Chat/))
    expect(chat().getAttribute('aria-current')).toBe('page')
    expect(central().getAttribute('aria-current')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Hide Secondary Side Bar' }))
    expect(chat().getAttribute('aria-current')).toBeNull()
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
