/** @vitest-environment jsdom */
// One bottom panel: Central, Activity, Problems and Output are tabs of it, and the Dock icons and
// status bar items highlight the SHOWN view (not merely open ones). Real AppDock + AppBottomPanel.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Node } from '@xyflow/react'
import AppDock from './App.chrome'
import AppBottomPanel from './App.bottomPanel'
import { ACTIVITY_STATUS_ITEM } from './App.hooks'
import { revealBottomView } from './bottomPanelHost'
import { useCentralControl } from './central/CentralControlPanel'
import type { CanvasViewport } from './canvasViewport'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { resetOutputStateForTest } from './output/outputCommands'
import { useOutputStatusItems } from './output/outputStatusItem'
import { useProblems } from './ProblemsPanel'
import { setTimelineOpen } from './Timeline'

const noop = () => {}
const VP: CanvasViewport = {
  zoom: 1, syncViewport: noop, onMoveEnd: noop, onFit: noop, onZoomIn: noop, onZoomOut: noop, onZoomTo: noop,
  onBack: noop, onForward: noop, canBack: false, canForward: false, resetViewport: noop,
}
const PROBLEMS = { problems: [], errors: 0, warnings: 0, running: false }

beforeEach(() => {
  localStorage.clear()
  revealBottomView(null)
  resetOutputStateForTest()
  setTimelineOpen(false)
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(String(url).includes('problems') ? JSON.stringify(PROBLEMS) : '[]')))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function App({ chat = false, initialCentral = false }: { chat?: boolean; initialCentral?: boolean }) {
  if (initialCentral) localStorage.setItem('webterm.centralControlOpen', '1')
  const central = useCentralControl(true)
  const [chatOpen, setChatOpen] = useState(chat)
  const [inboxOpen, setInboxOpen] = useState(false)
  const nodesRef = useRef<Node[]>([])
  const problems = useProblems('ws1')
  const outputItems = useOutputStatusItems()
  return (
    <>
      <AppDock
        vp={VP} settings={DEFAULT_SETTINGS} activeWs={null} central={central} board={false} setBoard={noop}
        sessionsOpen={false} setSessionsOpen={noop} inboxOpen={inboxOpen} setInboxOpen={setInboxOpen}
        chatOpen={chatOpen} setChatOpen={setChatOpen} locked={false} setLocked={noop} cleanView={false}
        toggleCleanView={noop} setPicker={noop} setShowSettings={noop} onAddTerminal={noop} onAddAgent={noop}
        onCreateWorkspace={noop} onUndo={noop} onRedo={noop} canUndo={false} canRedo={false}
        extraStatusItems={[...problems.statusItems, ACTIVITY_STATUS_ITEM, ...outputItems]}
      />
      <AppBottomPanel central={central} inboxOpen={inboxOpen} setInboxOpen={setInboxOpen} chatOpen={chatOpen}
        setChatOpen={setChatOpen} problems={problems} nodes={[]} nodesRef={nodesRef} addFlowNode={noop}
        onFocus={noop} workspaces={[]} />
    </>
  )
}

const central = () => screen.getByRole('button', { name: 'Toggle central control panel' })
const chat = () => screen.getByRole('button', { name: 'Toggle chat panel' })
const tab = (name: RegExp) => within(screen.getByRole('tablist', { name: 'Panel tabs' })).getByRole('tab', { name })
const shownTab = () => [...document.querySelectorAll('[role=tab][aria-selected=true]')].map((t) => t.textContent).join()

describe('Central as a bottom panel view', () => {
  it('opens as a tab of the single host while Chat is open, with no standalone surface', async () => {
    render(<App chat />)
    fireEvent.click(central())
    expect(await screen.findByRole('tab', { name: 'Control' })).toBeTruthy()
    expect(document.querySelectorAll('.vscode-bottom-panel')).toHaveLength(1)
    expect(document.querySelectorAll('.bottom-panel-host')).toHaveLength(1)
    expect(tab(/^Chat/)).toBeTruthy()
    expect(tab(/^Central/).getAttribute('aria-selected')).toBe('true')
    for (const panel of document.querySelectorAll('.ccp-panel')) expect(panel.closest('.bottom-panel-host')).not.toBeNull()
  })

  it('Dock toggle: closed opens, hidden reveals, shown closes', async () => {
    render(<App chat />)
    fireEvent.click(central())
    await screen.findByRole('tab', { name: 'Control' })
    fireEvent.click(chat()) // Chat is open but hidden behind Central: reveal, do not close
    expect(tab(/^Chat/).getAttribute('aria-selected')).toBe('true')
    expect(tab(/^Central/)).toBeTruthy()
    fireEvent.click(central()) // Central hidden: reveal
    expect(tab(/^Central/).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(central()) // shown: close
    expect(screen.queryByRole('tab', { name: /^Central/ })).toBeNull()
    expect(tab(/^Chat/)).toBeTruthy()
  })
})

describe('shown-view highlight', () => {
  it('highlights the Dock icon of the shown view only, and follows tab switches', async () => {
    render(<App chat initialCentral />)
    fireEvent.click(await screen.findByRole('tab', { name: /^Central/ }))
    expect(shownTab()).toMatch(/^Central/)
    expect(central().getAttribute('aria-current')).toBe('page')
    expect(chat().getAttribute('aria-current')).toBeNull()
    fireEvent.click(tab(/^Chat/))
    expect(chat().getAttribute('aria-current')).toBe('page')
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
