// The native app's update policy (updatePolicy.ts): configuration, schedule, backoff, and the cycle's
// decisions for available / none / error, against a fake Updater.
import { expect, test } from 'bun:test'
import {
  CHECK_INTERVAL_MS, FAILURE_BACKOFF_BASE_MS, INITIAL_UPDATE_STATE, type UpdateDeps, type UpdateOutcome, decide, nextCheckDelayMs,
  runUpdateCycle, updatesConfigured,
} from './updatePolicy'

test('an empty base URL means updates are not configured', () => {
  expect(updatesConfigured('')).toBe(false)
  expect(updatesConfigured('  ')).toBe(false)
  expect(updatesConfigured('https://example.test/webterm')).toBe(true) // test-only
})

test('checks every 6 hours; failures back off from 15 min, doubling, capped at the interval', () => {
  expect(CHECK_INTERVAL_MS).toBe(6 * 3_600_000)
  expect(nextCheckDelayMs(0)).toBe(CHECK_INTERVAL_MS)
  expect(nextCheckDelayMs(1)).toBe(FAILURE_BACKOFF_BASE_MS)
  expect(nextCheckDelayMs(2)).toBe(2 * FAILURE_BACKOFF_BASE_MS)
  expect(nextCheckDelayMs(3)).toBe(4 * FAILURE_BACKOFF_BASE_MS)
  expect(nextCheckDelayMs(50)).toBe(CHECK_INTERVAL_MS)
})

test('decide: error counts a failure, a success resets it, a ready update is announced once per hash', () => {
  const failed = decide({ failures: 2, notifiedHash: null }, { kind: 'error', message: 'HTTP 404' })
  expect(failed).toEqual({ action: { kind: 'warn', message: 'HTTP 404' }, state: { failures: 3, notifiedHash: null } })
  expect(decide({ failures: 3, notifiedHash: null }, { kind: 'none' })).toEqual({ action: { kind: 'none' }, state: { failures: 0, notifiedHash: null } })
  expect(decide(INITIAL_UPDATE_STATE, { kind: 'available', version: '1.1.0', hash: 'h1', ready: false }).action).toEqual({ kind: 'download', version: '1.1.0' })
  const told = decide(INITIAL_UPDATE_STATE, { kind: 'available', version: '1.1.0', hash: 'h1', ready: true })
  expect(told).toEqual({ action: { kind: 'notify', version: '1.1.0', hash: 'h1' }, state: { failures: 0, notifiedHash: 'h1' } })
  expect(decide(told.state, { kind: 'available', version: '1.1.0', hash: 'h1', ready: true }).action).toEqual({ kind: 'already-notified' })
  expect(decide(told.state, { kind: 'available', version: '1.2.0', hash: 'h2', ready: true }).action.kind).toBe('notify')
})

/** A fake Updater: `check` / `download` return the queued outcomes; calls are recorded. */
function fake(checks: UpdateOutcome[], downloads: UpdateOutcome[] = []) {
  const calls: string[] = []
  const deps: UpdateDeps = {
    check: async () => { calls.push('check'); return checks.shift() ?? { kind: 'none' } },
    download: async () => { calls.push('download'); return downloads.shift() ?? { kind: 'none' } },
    notifyReady: (v) => calls.push(`notify ${v}`),
    warn: (m) => calls.push(`warn ${m}`),
    info: () => {},
  }
  return { deps, calls }
}

test('cycle, available: downloads in the background, then tells the user; the next cycle does not repeat it', async () => {
  const { deps, calls } = fake(
    [{ kind: 'available', version: '1.1.0', hash: 'h1', ready: false }, { kind: 'available', version: '1.1.0', hash: 'h1', ready: true }],
    [{ kind: 'available', version: '1.1.0', hash: 'h1', ready: true }],
  )
  const first = await runUpdateCycle(INITIAL_UPDATE_STATE, deps)
  expect(calls).toEqual(['check', 'download', 'notify 1.1.0'])
  expect(first.nextDelayMs).toBe(CHECK_INTERVAL_MS)
  await runUpdateCycle(first.state, deps)
  expect(calls).toEqual(['check', 'download', 'notify 1.1.0', 'check'])
})

test('cycle, already staged at launch ("Later" last run): told again without downloading', async () => {
  const { deps, calls } = fake([{ kind: 'available', version: '1.1.0', hash: 'h1', ready: true }])
  await runUpdateCycle(INITIAL_UPDATE_STATE, deps)
  expect(calls).toEqual(['check', 'notify 1.1.0'])
})

test('cycle, none: nothing to do, regular interval', async () => {
  const { deps, calls } = fake([{ kind: 'none' }])
  expect((await runUpdateCycle(INITIAL_UPDATE_STATE, deps)).nextDelayMs).toBe(CHECK_INTERVAL_MS)
  expect(calls).toEqual(['check'])
})

test('cycle, errors: warn with context, back off, never notify or download', async () => {
  const { deps, calls } = fake([{ kind: 'error', message: 'Failed to check for updates: HTTP 404' }])
  const r = await runUpdateCycle(INITIAL_UPDATE_STATE, deps)
  expect(calls).toEqual(['check', 'warn [webterm] update check failed (attempt 1): Failed to check for updates: HTTP 404'])
  expect(r).toEqual({ state: { failures: 1, notifiedHash: null }, nextDelayMs: FAILURE_BACKOFF_BASE_MS })
})

test('cycle, a failed download (bad patch) is a backed-off failure, and a not-staged download is not retried in the same cycle', async () => {
  const bad = fake([{ kind: 'available', version: '1.1.0', hash: 'h1', ready: false }], [{ kind: 'error', message: 'Failed to download update: patch failed' }])
  expect((await runUpdateCycle(INITIAL_UPDATE_STATE, bad.deps)).state.failures).toBe(1)
  expect(bad.calls).toEqual(['check', 'download', 'warn [webterm] update check failed (attempt 1): Failed to download update: patch failed'])
  const stuck = fake([{ kind: 'available', version: '1.1.0', hash: 'h1', ready: false }], [{ kind: 'available', version: '1.1.0', hash: 'h1', ready: false }])
  const r = await runUpdateCycle({ failures: 1, notifiedHash: null }, stuck.deps)
  expect(stuck.calls.filter((c) => c === 'download')).toHaveLength(1)
  expect(r.state.failures).toBe(2)
  expect(r.nextDelayMs).toBe(2 * FAILURE_BACKOFF_BASE_MS)
})
