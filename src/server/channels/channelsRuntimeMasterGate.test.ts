// Gerbang induk kanal mengikuti kemampuan `telegram` (tak ada saklar kanal terpisah).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Ledger } from '../ledger/ledger'
import { channelsMasterState } from './channelsMasterGate'
import { startChannelsRuntime } from './channelsRuntime'

const SECRET = 'webhook-secret-for-tests-0123456789'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function tempStorePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'webterm-channel-gate-'))
  dirs.push(root)
  return join(root, 'channels', 'channels.json')
}

// Startup only checks that a ledger exists; no approval method is reached in these cases.
const ledger = {} as unknown as Ledger

const telegramOn = {
  WEBTERM_TELEGRAM: 'on',
  WEBTERM_TELEGRAM_WEBHOOK_SECRET: SECRET,
} as NodeJS.ProcessEnv

describe('channel master gate (follows telegram capability)', () => {
  it('is on exactly when telegram is on (dialect on|1|true, case/space tolerant)', () => {
    expect(channelsMasterState({})).toBe('off')
    for (const value of ['on', ' ON ', '1', 'true']) expect(channelsMasterState({ WEBTERM_TELEGRAM: value })).toBe('on')
    for (const value of ['off', '0', 'false', 'yes', '']) expect(channelsMasterState({ WEBTERM_TELEGRAM: value })).toBe('off')
  })

  it('starts the runtime when telegram is on', () => {
    const runtime = startChannelsRuntime(ledger, { env: telegramOn, storePath: tempStorePath() })
    expect(runtime).not.toBeNull()
    runtime?.stop()
  })

  it('stays null when telegram is off, without reading the secret', () => {
    const readSecret = vi.fn(() => ({ ok: true as const, text: SECRET }))
    expect(
      startChannelsRuntime(ledger, {
        env: { ...telegramOn, WEBTERM_TELEGRAM: 'off' },
        storePath: tempStorePath(),
        readSecret,
      })
    ).toBeNull()
    expect(readSecret).not.toHaveBeenCalled()
  })
})
