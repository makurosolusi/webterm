/** @vitest-environment jsdom */
// Wiring for the Output panel: store, shortcut, status bar items, View menu, palette and the
// bottom panel host. The panel body (W3) and the log stream are mocked; they have their own tests.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VscodeStatusBar } from '@/components/vscode/vscodeStatusBar'
import CanvasToolbar from '../CanvasToolbar'
import HelpOverlay from '../HelpOverlay'
import WorkspaceBar from '../WorkspaceBar'
import { isMacPlatform, terminalKeyAction } from '../terminalKeys'
import type { TerminalKeyEvent } from '../terminalKeys'
import { isOutputToggleChord, outputShortcutLabel } from './outputChord'
import {
  OUTPUT_OPEN_KEY, outputPaletteCommands, publishOutputCounts, resetOutputStateForTest,
  useOutputPanelState, useOutputToggleHotkey,
} from './outputCommands'
import { useOutputStatusItems } from './outputStatusItem'
import OutputPanelHost from './outputPanelHost'

const stream = vi.hoisted(() => ({
  value: {
    entries: [], channels: [], level: 'info', counts: { error: 0, warn: 0 }, connection: 'open',
    clear: vi.fn(async () => {}), setLevel: vi.fn(async (_l: string) => {}),
  },
}))
vi.mock('./useLogStream', () => ({ useLogStream: () => stream.value }))
vi.mock('./OutputPanel', () => ({
  default: (p: { onClose: () => void }) => <div data-testid="output-body"><button onClick={p.onClose}>close-body</button></div>,
}))

const chord = (over: Partial<TerminalKeyEvent> = {}): TerminalKeyEvent => ({
  type: 'keydown', key: 'U', code: 'KeyU', metaKey: false, ctrlKey: false, altKey: false, shiftKey: true, ...over,
})

beforeEach(() => {
  localStorage.clear()
  resetOutputStateForTest()
  stream.value = { ...stream.value, level: 'info', counts: { error: 0, warn: 0 }, clear: vi.fn(async () => {}), setLevel: vi.fn(async () => {}) }
})
afterEach(cleanup)

function Probe() {
  const { open } = useOutputPanelState()
  return <span data-testid="open">{String(open)}</span>
}
function StatusHarness() {
  useOutputToggleHotkey()
  return <><Probe /><VscodeStatusBar left={[]} right={useOutputStatusItems()} /></>
}

describe('output shortcut', () => {
  it('matches Shift+Cmd+U on mac and Shift+Ctrl+U elsewhere, and nothing else', () => {
    expect(isOutputToggleChord(chord({ metaKey: true }), true)).toBe(true)
    expect(isOutputToggleChord(chord({ ctrlKey: true }), false)).toBe(true)
    expect(isOutputToggleChord(chord({ ctrlKey: true }), true)).toBe(false)
    expect(isOutputToggleChord(chord({ metaKey: true, altKey: true }), true)).toBe(false)
    expect(isOutputToggleChord(chord({ metaKey: true, shiftKey: false }), true)).toBe(false)
    expect(outputShortcutLabel(true)).toBe('⇧⌘U')
    expect(outputShortcutLabel(false)).toBe('Ctrl+Shift+U')
  })

  it('is handed back to the app by xterm instead of being typed into the shell', () => {
    const linux = { isMac: false, isWindows: false }
    const mac = { isMac: true, isWindows: false }
    expect(terminalKeyAction(chord({ ctrlKey: true }), 'app-first', linux)).toBe('bubble')
    expect(terminalKeyAction(chord({ metaKey: true }), 'app-first', mac)).toBe('bubble')
    // Not gated by the policy: the chord is ours either way (like Clean View).
    expect(terminalKeyAction(chord({ ctrlKey: true }), 'terminal-first', linux)).toBe('bubble')
  })

  it('toggles the panel from the window and persists the choice', () => {
    render(<StatusHarness />)
    const isMac = /Mac/i.test(navigator.platform)
    const init = isMac ? { metaKey: true } : { ctrlKey: true }
    fireEvent.keyDown(window, { key: 'U', code: 'KeyU', shiftKey: true, ...init })
    expect(screen.getByTestId('open').textContent).toBe('true')
    expect(localStorage.getItem(OUTPUT_OPEN_KEY)).toBe('1')
    fireEvent.keyDown(window, { key: 'U', code: 'KeyU', shiftKey: true, ...init })
    expect(screen.getByTestId('open').textContent).toBe('false')
    fireEvent.keyDown(window, { key: 'U', code: 'KeyU', shiftKey: true, repeat: true, ...init })
    expect(screen.getByTestId('open').textContent).toBe('false') // key repeat is ignored
  })

  it('is listed in the Keyboard Shortcuts table', () => {
    render(<HelpOverlay onClose={() => {}} platform="Linux" />)
    const row = screen.getByText(/Toggle Output/).closest('tr') as HTMLElement
    expect(Array.from(row.querySelectorAll('kbd')).map((k) => k.textContent)).toEqual(['Ctrl', 'Shift', 'U'])
  })
})

describe('status bar items', () => {
  it('show the error and warning counts and a click opens the panel', () => {
    render(<StatusHarness />)
    act(() => publishOutputCounts({ error: 3, warn: 1 }))
    const errors = screen.getByRole('button', { name: /3 errors/ })
    expect(errors.textContent).toContain('3')
    fireEvent.focus(errors)
    expect(screen.getByRole('tooltip').textContent).toBe(`3 errors in the log — toggle Output ${outputShortcutLabel(isMacPlatform())}`)
    fireEvent.blur(errors)
    expect(screen.getByRole('button', { name: /1 warning$/ }).textContent).toContain('1')
    fireEvent.click(errors)
    expect(screen.getByTestId('open').textContent).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: /1 warning$/ }))
    expect(screen.getByTestId('open').textContent).toBe('false')
  })
})

describe('View menu', () => {
  const bar = () => render(
    <WorkspaceBar workspaces={[]} activeId={null} liveActiveNodes={null} statuses={{}} onSelect={() => {}}
      onNewWorkspace={() => {}} onRenameWorkspace={() => {}} onDeleteWorkspace={() => {}} />,
  )

  it('Output toggles the panel and Clear Output clears the stream', async () => {
    render(<><Probe /><OutputPanelHost /><WorkspaceBar workspaces={[]} activeId={null} liveActiveNodes={null} statuses={{}}
      onSelect={() => {}} onNewWorkspace={() => {}} onRenameWorkspace={() => {}} onDeleteWorkspace={() => {}} /></>)
    fireEvent.click(screen.getByRole('menuitem', { name: 'View' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Output/ }))
    expect(screen.getByTestId('open').textContent).toBe('true')
    fireEvent.click(screen.getByRole('menuitem', { name: 'View' }))
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Clear Output' })) })
    expect(stream.value.clear).toHaveBeenCalledTimes(1)
  })

  it('is placed between File and Help', () => {
    bar()
    const names = screen.getAllByRole('menuitem').map((m) => m.textContent)
    expect(names.indexOf('File')).toBeLessThan(names.indexOf('View'))
  })
})

describe('command palette', () => {
  function renderPalette() {
    const props = {
      nodes: [], onFocusNode: vi.fn(), onOpenExplorer: vi.fn(), onOpenSettings: vi.fn(), onOpenHelp: vi.fn(),
      commands: outputPaletteCommands(false), platform: 'Linux',
    }
    render(<><Probe /><OutputPanelHost /><CanvasToolbar {...props} /></>)
    fireEvent.click(screen.getByRole('button', { name: 'Command palette' }))
    return props
  }

  it('lists the three Output commands', () => {
    renderPalette()
    for (const label of ['View: Toggle Output', 'Output: Clear Output', 'Output: Set Log Level…']) {
      expect(screen.getByText(label)).not.toBeNull()
    }
  })

  it('Toggle Output opens the panel and does not focus a node', () => {
    const props = renderPalette()
    fireEvent.click(screen.getByText('View: Toggle Output'))
    expect(screen.getByTestId('open').textContent).toBe('true')
    expect(props.onFocusNode).not.toHaveBeenCalled()
  })

  it('Clear Output clears, and Set Log Level applies the chosen level', async () => {
    renderPalette()
    await act(async () => { fireEvent.click(screen.getByText('Output: Clear Output')) })
    expect(stream.value.clear).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Command palette' }))
    fireEvent.click(screen.getByText('Output: Set Log Level…'))
    const picker = await screen.findByRole('dialog', { name: 'Set Log Level' })
    expect(picker.textContent).toContain('Current')
    await act(async () => { fireEvent.click(screen.getByText('Warning')) })
    expect(stream.value.setLevel).toHaveBeenCalledWith('warn')
    expect(screen.queryByRole('dialog', { name: 'Set Log Level' })).toBeNull()
  })
})

describe('OutputPanelHost', () => {
  it('shows an OUTPUT tab with the panel only while open, and closes from the panel', () => {
    render(<><Probe /><OutputPanelHost /><StatusHarness /></>)
    expect(screen.queryByTestId('output-body')).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: /Toggle Output/ })[0]!)
    expect(screen.getByTestId('output-body')).not.toBeNull()
    expect(screen.getByRole('tab', { name: /Output/ })).not.toBeNull()
    fireEvent.click(screen.getByText('close-body'))
    expect(screen.queryByTestId('output-body')).toBeNull()
    expect(localStorage.getItem(OUTPUT_OPEN_KEY)).toBe('0')
  })

  it('publishes the stream counts to the status bar', () => {
    stream.value = { ...stream.value, counts: { error: 2, warn: 5 } }
    render(<><OutputPanelHost /><StatusHarness /></>)
    expect(screen.getByRole('button', { name: /2 errors/ })).not.toBeNull()
    expect(screen.getByRole('button', { name: /5 warnings/ })).not.toBeNull()
  })
})
