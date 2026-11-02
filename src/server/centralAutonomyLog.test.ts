import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configureLogging, getLogLevel, logBus, setLogLevel } from './logs'
import { createCentralAutonomy } from './central/centralAutonomy'

const prev = getLogLevel()
beforeEach(() => {
  setLogLevel('info')
  configureLogging({ console: false })
  logBus.clear()
})
afterEach(() => {
  setLogLevel(prev)
  configureLogging({ console: true })
  logBus.clear()
})

describe('central autonomy logging', () => {
  it('logs a failed run as warn, a successful one as info, and stop', async () => {
    let ok = false
    const loop = createCentralAutonomy({
      projects: () => [{ id: 'p1', status: 'active' }],
      plan: () => ({ status: 'open', version: 1, items: [{ id: 'i1', seq: 1, status: 'assigned' }] }),
      run: async () => (ok ? { ok: true } : { ok: false, code: 'run_failed' }),
      audit: () => undefined,
    })
    await loop.tick()
    ok = true
    await loop.tick()
    loop.start()
    loop.stop()
    const seen = logBus.snapshot().map((e) => [e.level, e.event])
    expect(seen).toEqual([
      ['warn', 'central.autonomy.run'],
      ['info', 'central.autonomy.run'],
      ['info', 'central.autonomy.stop'],
    ])
    expect(logBus.snapshot()[0]?.data).toMatchObject({ projectId: 'p1', code: 'run_failed' })
  })
})
