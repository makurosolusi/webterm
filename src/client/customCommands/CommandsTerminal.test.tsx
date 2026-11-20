/** @vitest-environment jsdom */
// The setup terminal box with a fake TerminalCore + ws: collapsed by default, session identity, quick
// commands typed without Enter, hidden chips for detected tools, close/unmount end the session, errors
// show Try again, and the idle rescan.
import { forwardRef, useImperativeHandle } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOOL } from './commands.fakeServer'
import { COMMANDS_TEXT } from './commands.labels'
import { COMMAND_RECIPES } from './commands.recipes'
import { CommandsTerminal, RESCAN_IDLE_MS, RESCAN_MIN_GAP_MS } from './CommandsTerminal'

const T = COMMANDS_TEXT.terminal
const h = vi.hoisted(() => ({ props: [] as Record<string, unknown>[], sendKeys: vi.fn(), send: vi.fn() }))
vi.mock('../ws', () => ({ send: h.send }))
vi.mock('../TerminalCore', () => ({
  default: forwardRef(function FakeCore(props: Record<string, unknown>, ref) {
    h.props.push(props)
    useImperativeHandle(ref, () => ({ sendKeys: h.sendKeys, focus: vi.fn() }))
    return <div data-fake-terminal />
  }),
}))

type FakeProps = { id: string; cwd: string; onOutput(): void; onExit(code: number, reason?: string): void }
const last = (): FakeProps => h.props[h.props.length - 1] as unknown as FakeProps
const found = (name: string) => TOOL({ name })
const mount = (detected: ReturnType<typeof found>[] = []) => {
  const onActivity = vi.fn(async () => {})
  return { onActivity, ...render(<CommandsTerminal detected={detected} onActivity={onActivity} />) }
}
const flush = async (): Promise<void> => { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const openIt = async (): Promise<void> => { fireEvent.click(screen.getByRole('button', { name: T.open })); await flush() }

beforeEach(() => { h.props.length = 0; h.sendKeys.mockClear(); h.send.mockClear() })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('CommandsTerminal', () => {
  it('is collapsed by default: no terminal, aria-expanded false, the honest one-line limit is shown', () => {
    mount()
    expect(screen.getByRole('button', { name: T.open }).getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('[data-fake-terminal]')).toBeNull()
    expect(h.props).toHaveLength(0)
    expect(screen.getByText(T.hint)).toBeTruthy()
  })

  it('open creates the session with the setup id in the home folder', async () => {
    mount()
    await openIt()
    expect(document.querySelector('[data-fake-terminal]')).toBeTruthy()
    expect(last().id).toBe('setup-terminal')
    expect(last().cwd).toBe('~')
    expect(screen.getByRole('button', { name: T.close }).getAttribute('aria-expanded')).toBe('true')
  })

  it('a quick command is typed without a newline', async () => {
    mount()
    await openIt()
    fireEvent.click(document.querySelector('[data-recipe="bun"]') as HTMLElement)
    expect(h.sendKeys).toHaveBeenCalledTimes(1)
    const typed = h.sendKeys.mock.calls[0]![0] as string
    expect(typed).toBe(COMMAND_RECIPES.find((r) => r.id === 'bun')!.command)
    expect(typed).not.toMatch(/[\r\n]/)
    expect(document.querySelector('[data-commands-recipes] code')?.textContent).toContain('https://')
  })

  it('hides a chip for a tool that is already found; login chips need their tool', async () => {
    mount([found('bun'), found('gh')])
    await openIt()
    expect(document.querySelector('[data-recipe="bun"]')).toBeNull()
    expect(document.querySelector('[data-recipe="gh-login"]')).toBeTruthy()
    expect(document.querySelector('[data-recipe="claude-login"]')).toBeNull()
    expect(document.querySelector('[data-recipe="python"]')).toBeTruthy()
  })

  it('Close ends the PTY session', async () => {
    mount()
    await openIt()
    fireEvent.click(screen.getByRole('button', { name: T.close }))
    expect(h.send).toHaveBeenCalledWith({ t: 'close', id: 'setup-terminal' })
    expect(document.querySelector('[data-fake-terminal]')).toBeNull()
  })

  it('unmounting while open ends the session; unmounting while closed sends nothing', async () => {
    const a = mount()
    a.unmount()
    expect(h.send).not.toHaveBeenCalled()
    const b = mount()
    await openIt()
    b.unmount()
    expect(h.send).toHaveBeenCalledWith({ t: 'close', id: 'setup-terminal' })
  })

  it('a failed open shows a message and Try again mounts a fresh terminal', async () => {
    mount()
    await openIt()
    act(() => { last().onExit(-1, 'failed') })
    expect(screen.getByText(T.failed)).toBeTruthy()
    expect(document.querySelector('[data-fake-terminal]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: T.retry }))
    await flush()
    expect(document.querySelector('[data-fake-terminal]')).toBeTruthy()
  })

  it('the shell ending on its own says so', async () => {
    mount()
    await openIt()
    act(() => { last().onExit(0, 'self') })
    expect(screen.getByText(T.ended)).toBeTruthy()
  })

  it('rescans once output goes quiet after a quick command, at most every 5s; never before one is used', async () => {
    const { onActivity } = mount()
    await openIt()
    vi.useFakeTimers()
    act(() => { last().onOutput() })
    act(() => { vi.advanceTimersByTime(RESCAN_IDLE_MS + 10) })
    expect(onActivity).not.toHaveBeenCalled() // no quick command used yet
    fireEvent.click(document.querySelector('[data-recipe="python"]') as HTMLElement)
    act(() => { last().onOutput() })
    act(() => { vi.advanceTimersByTime(RESCAN_IDLE_MS - 1) })
    act(() => { last().onOutput() }) // more output: the wait restarts
    act(() => { vi.advanceTimersByTime(RESCAN_IDLE_MS - 1) })
    expect(onActivity).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(2) })
    expect(onActivity).toHaveBeenCalledTimes(1)
    act(() => { last().onOutput() })
    act(() => { vi.advanceTimersByTime(RESCAN_IDLE_MS + 10) })
    expect(onActivity).toHaveBeenCalledTimes(1) // inside the 5s gap
    act(() => { vi.advanceTimersByTime(RESCAN_MIN_GAP_MS) })
    expect(onActivity).toHaveBeenCalledTimes(2)
  })
})
