// The `WEBTERM_CHANNELS` master kill switch: it sits above `WEBTERM_TELEGRAM` and any unsupported
// value fails closed. Split from channelsRuntime.test.ts to keep both files under the size limit.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Ledger } from '../ledger/ledger'
import { CHANNELS_MASTER_ENV, channelsMasterState, startChannelsRuntime } from './channelsRuntime'

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

describe('WEBTERM_CHANNELS master gate', () => {
  it('parses only on|off and fails closed on anything else', () => {
    expect(channelsMasterState({} as NodeJS.ProcessEnv)).toBe('on')
    expect(channelsMasterState({ WEBTERM_CHANNELS: 'on' } as NodeJS.ProcessEnv)).toBe('on')
    expect(channelsMasterState({ WEBTERM_CHANNELS: ' OFF ' } as NodeJS.ProcessEnv)).toBe('off')
    for (const value of ['1', 'true']) expect(channelsMasterState({ WEBTERM_CHANNELS: value } as NodeJS.ProcessEnv)).toBe('on')
    for (const value of ['0', 'false']) expect(channelsMasterState({ WEBTERM_CHANNELS: value } as NodeJS.ProcessEnv)).toBe('off')
    for (const value of ['readonly', 'control', 'yes']) {
      expect(channelsMasterState({ WEBTERM_CHANNELS: value } as NodeJS.ProcessEnv)).toBe('unsupported')
    }
  })

  it('starts when the master switch is unset or on and telegram is on', () => {
    for (const env of [telegramOn, { ...telegramOn, WEBTERM_CHANNELS: 'on' } as NodeJS.ProcessEnv]) {
      const runtime = startChannelsRuntime(ledger, { env, storePath: tempStorePath() })
      expect(runtime).not.toBeNull()
      runtime?.stop()
    }
  })

  it('keeps telegram off a null runtime even with the master switch on', () => {
    expect(
      startChannelsRuntime(ledger, {
        env: { WEBTERM_CHANNELS: 'on' } as NodeJS.ProcessEnv,
        storePath: tempStorePath(),
      })
    ).toBeNull()
  })

  it('disables everything on master off even when telegram is on, without reading the secret', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const readSecret = vi.fn(() => ({ ok: true as const, text: SECRET }))
    expect(
      startChannelsRuntime(ledger, {
        env: { ...telegramOn, WEBTERM_CHANNELS: 'off' },
        storePath: tempStorePath(),
        readSecret,
      })
    ).toBeNull()
    expect(readSecret).not.toHaveBeenCalled()
    // A deliberate `off` is not a misconfiguration, so it logs nothing.
    expect(warn).not.toHaveBeenCalled()
  })

  it('fails closed with one redacted warning on an unsupported value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const value of ['readonly', 'control']) {
      expect(
        startChannelsRuntime(ledger, {
          env: { ...telegramOn, WEBTERM_CHANNELS: value },
          storePath: tempStorePath(),
        })
      ).toBeNull()
    }
    const logged = warn.mock.calls.map((call) => String(call[0]))
    expect(logged).toHaveLength(2)
    for (const line of logged) {
      expect(line).toContain(CHANNELS_MASTER_ENV)
      expect(line).toContain('on|off')
      // The operator value never reaches the log.
      expect(line).not.toContain('readonly')
      expect(line).not.toContain('control')
    }
  })
})
