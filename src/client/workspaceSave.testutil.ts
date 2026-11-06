// Test-only: the board save debounce, fired by hand instead of by the wall clock.
import { act, waitFor } from '@testing-library/react'
import { expect, onTestFinished, vi } from 'vitest'
import { SAVE_DEBOUNCE_MS } from './workspaceSaver'

type Timer = ReturnType<typeof setTimeout>

/**
 * Holds every timer armed with the save debounce delay (`scheduleSave`'s), honouring `clearTimeout`
 * on it; all other timers keep the real clock. `fire` waits for a save to be scheduled, then runs it.
 */
export function holdSaveTimer(): { fire: () => Promise<void> } {
  const held = new Map<Timer, () => void>()
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const set = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...a: unknown[]) => {
    if (ms !== SAVE_DEBOUNCE_MS) return realSet(fn, ms, ...a)
    const handle = {} as Timer // unique and truthy, never a real timer id
    held.set(handle, fn)
    return handle
  }) as typeof setTimeout)
  const clear = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((t?: Timer) => {
    if (t !== undefined && held.delete(t)) return
    realClear(t)
  }) as typeof clearTimeout)
  onTestFinished(() => { set.mockRestore(); clear.mockRestore() })
  return {
    fire: async () => {
      await waitFor(() => expect(held.size).toBeGreaterThan(0))
      const due = [...held.values()]
      held.clear()
      await act(async () => { for (const fn of due) fn() })
    },
  }
}
