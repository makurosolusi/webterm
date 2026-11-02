import { expect, test } from 'bun:test'
import { configureLogging, logBus } from '../logs'
import { startLedgerReaper, startLedgerRuntime } from './ledgerRuntime'

// bun:test's ambient types here have no beforeEach/toEqual; each test resets the bus itself.
function quiet(): void {
  configureLogging({ console: false })
  logBus.clear()
}

test('ledger start/stop and reaper lifecycle are logged without the full db path', () => {
  quiet()
  const runtime = startLedgerRuntime({ mode: 'on', path: ':memory:' })
  const stopReaper = startLedgerReaper({ task: { sweepExpiredLeases: () => 0 } }, 60_000)
  stopReaper()
  runtime?.close()
  const events = logBus.snapshot().map((e) => e.event).join(',')
  configureLogging({ console: true })
  expect(events).toBe('ledger.start,ledger.reaper.start,ledger.reaper.stop,ledger.stop')
})

test('reaper tick failure is logged at error level with the reason only', async () => {
  quiet()
  const stop = startLedgerReaper({ task: { sweepExpiredLeases: () => { throw new Error('db locked') } } }, 5)
  await new Promise((r) => setTimeout(r, 30))
  stop()
  const failure = logBus.snapshot().find((e) => e.event === 'ledger.reaper.error')
  configureLogging({ console: true })
  expect(failure?.level).toBe('error')
  expect(failure?.message).toContain('db locked')
})
