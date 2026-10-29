import { afterEach, expect, test, vi } from 'vitest'
import { randomId } from './randomId'

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

afterEach(() => vi.unstubAllGlobals())

test('mints a well-formed v4 uuid and never repeats', () => {
  const ids = new Set(Array.from({ length: 1000 }, randomId))
  expect(ids.size).toBe(1000)
  for (const id of ids) expect(id).toMatch(V4)
})

test('falls back to getRandomValues when randomUUID is missing (insecure http origin)', () => {
  // The exact failure: over http from a LAN address the page is not a secure context, so
  // crypto.randomUUID is undefined and calling it threw — blanking the app. getRandomValues stays.
  const real = globalThis.crypto
  vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) })
  expect((globalThis.crypto as Crypto).randomUUID).toBeUndefined()
  expect(randomId()).toMatch(V4)
})
