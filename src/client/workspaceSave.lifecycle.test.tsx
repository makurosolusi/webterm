/**
 * @vitest-environment jsdom
 */
// Page-lifecycle hooks of the board save.
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSaveLifecycle } from './workspaceSave.lifecycle'
import { setConnection } from './ws.connection'

function setup(unsaved: boolean) {
  const deps = { flushSave: vi.fn(), retrySave: vi.fn(), hasUnsaved: vi.fn(() => unsaved) }
  const view = renderHook(() => useSaveLifecycle(deps))
  return { ...deps, view }
}

const setVisibility = (v: DocumentVisibilityState) => Object.defineProperty(document, 'visibilityState', { value: v, configurable: true })

afterEach(() => { cleanup(); setVisibility('visible') })

describe('useSaveLifecycle', () => {
  it('flushes when the tab is hidden, not when it comes back', () => {
    const { flushSave } = setup(false)
    setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(flushSave).not.toHaveBeenCalled()
    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(flushSave).toHaveBeenCalledTimes(1)
  })

  it('beforeunload flushes and asks only while something is unsaved', () => {
    const clean = setup(false)
    const e1 = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(e1)
    expect(clean.flushSave).toHaveBeenCalledTimes(1)
    expect(e1.defaultPrevented).toBe(false)
    clean.view.unmount()

    setup(true)
    const e2 = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(e2)
    expect(e2.defaultPrevented).toBe(true)
  })

  it('retries a failed save when the browser comes back online, and stops listening on unmount', () => {
    const { retrySave, flushSave, view } = setup(false)
    window.dispatchEvent(new Event('online'))
    expect(retrySave).toHaveBeenCalledTimes(1)
    view.unmount()
    window.dispatchEvent(new Event('online'))
    window.dispatchEvent(new Event('pagehide'))
    expect(retrySave).toHaveBeenCalledTimes(1)
    expect(flushSave).not.toHaveBeenCalled()
  })

  it('retries when the socket enters connected from another phase, not on every connected update', () => {
    setConnection({ phase: 'reconnecting', attempt: 1 })
    const { retrySave, view } = setup(false)
    setConnection({ phase: 'connected', attempt: 0 })
    expect(retrySave).toHaveBeenCalledTimes(1)
    setConnection({ phase: 'connected', attempt: 0, bootId: 'b2' }) // same phase, new hello data
    expect(retrySave).toHaveBeenCalledTimes(1)
    setConnection({ phase: 'auth', attempt: 0 })
    setConnection({ phase: 'connected', attempt: 0 })
    expect(retrySave).toHaveBeenCalledTimes(2)
    view.unmount()
    setConnection({ phase: 'offline', attempt: 0 })
    setConnection({ phase: 'connected', attempt: 0 })
    expect(retrySave).toHaveBeenCalledTimes(2)
  })
})
