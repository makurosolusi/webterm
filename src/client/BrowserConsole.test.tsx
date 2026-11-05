/** @vitest-environment jsdom */
// Console drawer: level/text filters (Verbose hidden by default), Clear/Preserve/eval send server commands,
// the agent lease disables the prompt, the toolbar toggle shows the error badge only while closed.
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import { applyConsoleDelta, EMPTY_CONSOLE } from '../shared/browser.console'
import type { ConsoleEntry, ConsoleView } from '../shared/browser.console'
import BrowserConsole, { BrowserConsoleToggle, CONSOLE_TEXT, errorCount, useConsoleDrawer } from './BrowserConsole'

afterEach(cleanup)
const e = (seq: number, level: ConsoleEntry['level'], text: string, over: Partial<ConsoleEntry> = {}): ConsoleEntry => ({ seq, ts: 0, level, source: 'console', text, ...over })
const VIEW: ConsoleView = { // test-only
  entries: [e(1, 'verbose', 'debug detail'), e(2, 'info', 'hello world', { url: 'https://a.test/js/app.js?v=2', line: 12 }), e(3, 'warning', 'deprecated api'), e(4, 'error', 'Uncaught boom', { source: 'exception' })],
  dropped: 3, preserve: false, capturing: true,
}
const texts = () => screen.getAllByRole('listitem').map((r) => r.querySelector('.browser-console__text')?.textContent)

function setup(view: ConsoleView = VIEW, lease: 'human' | 'agent' = 'human') {
  const send = vi.fn()
  render(<BrowserConsole view={view} send={send} lease={lease} />)
  return { send }
}

describe('BrowserConsole', () => {
  it('hides Verbose by default, shows source links and the drop note', () => {
    setup()
    expect(texts()).toEqual(['hello world', 'deprecated api', 'Uncaught boom'])
    expect(screen.getByText('app.js:12')).toBeTruthy()
    expect(screen.getByText(CONSOLE_TEXT.dropped(3))).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: CONSOLE_TEXT.verbose }))
    expect(texts()).toContain('debug detail')
  })

  it('filters by level and by text', () => {
    setup()
    const levels = within(screen.getByRole('group', { name: CONSOLE_TEXT.levels }))
    fireEvent.click(levels.getByRole('button', { name: CONSOLE_TEXT.error }))
    expect(texts()).toEqual(['Uncaught boom'])
    fireEvent.click(levels.getByRole('button', { name: CONSOLE_TEXT.warning }))
    expect(texts()).toEqual(['deprecated api'])
    fireEvent.click(levels.getByRole('button', { name: CONSOLE_TEXT.all }))
    fireEvent.change(screen.getByLabelText(CONSOLE_TEXT.filter), { target: { value: 'APP.JS' } })
    expect(texts()).toEqual(['hello world'])
  })

  it('Clear, Preserve log and Enter in the prompt send console commands', () => {
    const { send } = setup()
    fireEvent.click(screen.getByRole('button', { name: CONSOLE_TEXT.clear }))
    fireEvent.click(screen.getByRole('checkbox', { name: CONSOLE_TEXT.preserve }))
    const prompt = screen.getByLabelText(CONSOLE_TEXT.prompt) as HTMLInputElement
    fireEvent.change(prompt, { target: { value: 'document.title' } })
    fireEvent.keyDown(prompt, { key: 'Enter' })
    expect(send.mock.calls.map((c) => c[0])).toEqual([
      { t: 'console', op: 'clear' }, { t: 'console', op: 'preserve', on: true }, { t: 'console', op: 'eval', expr: 'document.title' },
    ])
    expect(prompt.value).toBe('')
  })

  it('disables the prompt while an agent holds the lease', () => {
    setup(VIEW, 'agent')
    expect((screen.getByLabelText(CONSOLE_TEXT.prompt) as HTMLInputElement).disabled).toBe(true)
  })

  it('a reset delta (Clear / navigation) empties the list', () => {
    const v = applyConsoleDelta(VIEW, { id: 'n1', entries: [], dropped: 0, preserve: false, capturing: true, reset: true })
    setup(v)
    expect(screen.queryAllByRole('listitem')).toEqual([])
    expect(screen.getByText(CONSOLE_TEXT.empty)).toBeTruthy()
  })
})

describe('console view merge', () => {
  it('appends deltas without repeating entries the snapshot already had', () => {
    const a = applyConsoleDelta(EMPTY_CONSOLE, { id: 'n1', entries: [e(1, 'info', 'a'), e(2, 'info', 'b')], dropped: 0, preserve: false, capturing: true, reset: true })
    const b = applyConsoleDelta(a, { id: 'n1', entries: [e(2, 'info', 'b'), e(3, 'error', 'c')], dropped: 1, preserve: true, capturing: true })
    expect(b.entries.map((x) => x.seq)).toEqual([1, 2, 3])
    expect(b).toMatchObject({ dropped: 1, preserve: true })
    expect(errorCount(b)).toBe(1)
  })
})

describe('BrowserConsoleToggle', () => {
  it('shows the error badge only while closed and toggles on click', () => {
    const toggle = vi.fn()
    const { rerender } = render(<BrowserConsoleToggle open={false} errors={2} toggle={toggle} />)
    const btn = screen.getByRole('button', { name: CONSOLE_TEXT.toggle })
    expect(within(btn).getByLabelText(CONSOLE_TEXT.errors(2)).textContent).toBe('2')
    fireEvent.click(btn)
    expect(toggle).toHaveBeenCalledOnce()
    rerender(<BrowserConsoleToggle open errors={2} toggle={toggle} />)
    expect(within(screen.getByRole('button', { name: CONSOLE_TEXT.toggle })).queryByLabelText(CONSOLE_TEXT.errors(2))).toBeNull()
  })
})

describe('useConsoleDrawer lazy capture', () => {
  const hostRef = { current: null } // test-only
  function drawer(capturing: boolean) {
    const send = vi.fn()
    const reload = vi.fn()
    const hook = renderHook(({ view }) => useConsoleDrawer(hostRef, view, send, 'human', reload), { initialProps: { view: { ...EMPTY_CONSOLE, capturing } } })
    return { send, reload, hook }
  }

  it('opening asks the server to start capture and shows the reload hint; Reload reuses the reload path', () => {
    const { send, reload, hook } = drawer(false)
    expect(send).not.toHaveBeenCalled() // closed drawer: nothing enabled
    act(() => hook.result.current.slot.toggle())
    expect(send.mock.calls.map((c) => c[0])).toEqual([{ t: 'console', op: 'open' }])
    hook.rerender({ view: { ...EMPTY_CONSOLE, capturing: true } }) // server confirms
    render(<>{hook.result.current.drawer}</>)
    expect(screen.getByRole('status').textContent).toContain(CONSOLE_TEXT.captureStarted)
    fireEvent.click(screen.getByRole('button', { name: CONSOLE_TEXT.reload }))
    expect(reload).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledOnce()
  })

  it('no hint and no open command when capture is already on', () => {
    const { send, hook } = drawer(true)
    act(() => hook.result.current.slot.toggle())
    render(<>{hook.result.current.drawer}</>)
    expect(screen.queryByRole('status')).toBeNull()
    expect(send).not.toHaveBeenCalled()
  })
})
