import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Ledger } from '../ledger/ledger'
import { createManagedBotRegistry } from './botManaged'
import { CENTRAL_BOTS_FLAG } from './botManager'
import { startChannelsRuntime } from './channelsRuntime'

const SECRET = 'webhook-secret-for-tests-0123456789'
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const ledger = { approval: {}, event: { appendEvent: () => ({ seq: 1 }) } } as unknown as Ledger
function start(extra: Record<string, string>, withBots: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'webterm-bots-rt-'))
  dirs.push(root)
  const runtime = startChannelsRuntime(ledger, {
    env: { WEBTERM_TELEGRAM: 'on', WEBTERM_TELEGRAM_WEBHOOK_SECRET: SECRET, ...extra } as NodeJS.ProcessEnv,
    storePath: join(root, 'channels', 'channels.json'),
    sender: { intervalMs: 60_000 },
    ...(withBots ? { bots: { registry: createManagedBotRegistry() } } : {}),
  })
  if (!runtime) throw new Error('channel runtime did not start')
  return runtime
}

describe('managed bots mount', () => {
  it('flag off (unset or off) mounts nothing', () => {
    expect(start({}, true).bots).toBeNull()
    expect(start({ [CENTRAL_BOTS_FLAG]: 'off' }, true).bots).toBeNull()
  })
  it('flag on mounts the manager', () => {
    const runtime = start({ [CENTRAL_BOTS_FLAG]: 'on' }, true)
    expect(runtime.bots?.registry.list()).toEqual([])
    runtime.stop()
  })
})
