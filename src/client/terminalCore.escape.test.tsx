/**
 * @vitest-environment jsdom
 */
// Opt-in focus exit (WCAG 2.1.2): with `escapeChord` the leave chord is swallowed, blurs xterm and calls
// `onLeave`; without the prop the handler lets every key through, exactly as before.
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { installCanvasDom } from './canvasHarness'
import TerminalCore from './TerminalCore'

type KeyHandler = (e: KeyboardEvent) => boolean
const { handlers, blurs } = vi.hoisted(() => ({ handlers: [] as KeyHandler[], blurs: [] as number[] }))
vi.mock('./ws', async (importOriginal) => ({ ...(await importOriginal<typeof import('./ws')>()), send: vi.fn() }))
vi.mock('@xterm/xterm', async (importOriginal) => {
  const real = await importOriginal<typeof import('@xterm/xterm')>()
  class Recorded extends real.Terminal {
    attachCustomKeyEventHandler(h: KeyHandler): void { handlers.push(h); super.attachCustomKeyEventHandler(h) }
    blur(): void { blurs.push(1); super.blur() }
  }
  return { ...real, Terminal: Recorded }
})

const press = (init: KeyboardEventInit): KeyboardEvent => new KeyboardEvent('keydown', { cancelable: true, ...init })
const LEAVE = { key: 'Escape', code: 'Escape', ctrlKey: true, altKey: true }

beforeAll(() => { installCanvasDom() })
afterEach(() => { cleanup(); handlers.length = 0; blurs.length = 0 })

describe('TerminalCore escapeChord', () => {
  it('leave chord is not forwarded, blurs the terminal and calls onLeave', () => {
    const onLeave = vi.fn()
    render(<TerminalCore id="t1" escapeChord onLeave={onLeave} />)
    const e = press(LEAVE)
    expect(handlers[0]!(e)).toBe(false) // false = xterm does not process (so nothing reaches the PTY)
    expect(e.defaultPrevented).toBe(true)
    expect(blurs).toHaveLength(1)
    expect(onLeave).toHaveBeenCalledTimes(1)
  })

  it('other keys (Esc, Tab, Ctrl+M, Ctrl+C) still go to xterm and never leave', () => {
    const onLeave = vi.fn()
    render(<TerminalCore id="t2" escapeChord onLeave={onLeave} />)
    for (const init of [{ key: 'Escape' }, { key: 'Tab' }, { key: 'm', ctrlKey: true }, { key: 'c', ctrlKey: true }]) {
      expect(handlers[0]!(press(init))).toBe(true)
    }
    expect(onLeave).not.toHaveBeenCalled()
    expect(blurs).toHaveLength(0)
  })

  it('without the prop the chord is not special: old behaviour intact', () => {
    const onLeave = vi.fn()
    render(<TerminalCore id="t3" onLeave={onLeave} />)
    handlers[0]!(press(LEAVE))
    expect(onLeave).not.toHaveBeenCalled()
    expect(blurs).toHaveLength(0)
  })
})
