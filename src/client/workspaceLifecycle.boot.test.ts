/** @vitest-environment jsdom */
// The boot fetch doubles as the auth probe: a 403 raises authRequired (App renders SignInScreen)
// instead of the retrying error screen.
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pickBootWorkspace, useWorkspaceBoot } from './workspaceLifecycle.boot'

afterEach(() => vi.unstubAllGlobals())

it('a 403 boot raises authRequired and hydrated, with no error state and no retry', async () => {
  const f = vi.fn(async () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }))
  vi.stubGlobal('fetch', f)
  const setAuthRequired = vi.fn()
  const setHydrated = vi.fn()
  const deps = { applyWorkspace: () => {}, setWorkspaces: () => {}, setHydrated, setAuthRequired } // stable: applyWorkspace is an effect dep
  const { result } = renderHook(() => useWorkspaceBoot(deps))
  await waitFor(() => expect(setAuthRequired).toHaveBeenCalledWith(true))
  expect(setHydrated).toHaveBeenCalledWith(true)
  expect(result.current.boot.kind).toBe('loading')
})

describe('pickBootWorkspace', () => {
  it('the URL id wins over the server active board when it exists', () => {
    expect(pickBootWorkspace(['a', 'b'], 'b', 'a')).toBe('b')
  })
  it('an unknown or absent URL id falls back to the active board, then the first', () => {
    expect(pickBootWorkspace(['a', 'b'], 'zz', 'b')).toBe('b')
    expect(pickBootWorkspace(['a', 'b'], null, 'b')).toBe('b')
    expect(pickBootWorkspace(['a', 'b'], undefined, null)).toBe('a')
    expect(pickBootWorkspace([], 'a', 'a')).toBeNull()
  })
})
