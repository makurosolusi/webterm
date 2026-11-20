import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandSecretWarning } from './claudeProvider.command'
import { isReady, parseUpdate, providerEnv } from './claudeProvider.model'
import { commandProfileOverride, loadConfig, providerView, saveProvider } from './claudeProvider.store'
import { registerClaudeLaunchSettings } from '../claudeLauncher/claudeLauncher'
import { DEFAULT_SETTINGS } from '../../shared/settings'

const KEY = 'sk-test-only-0123456789abcdef' // test-only
let dir = ''
let prev: string | undefined
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cp-cmdstore-'))
  prev = process.env.WEBTERM_DATA_DIR
  process.env.WEBTERM_DATA_DIR = join(dir, 'data')
  registerClaudeLaunchSettings(() => ({ ...DEFAULT_SETTINGS, claudeLaunchProfiles: [{ id: 'm', name: 'M', command: 'envman -e claude:x -- claude' }] }))
})
afterEach(() => {
  process.env.WEBTERM_DATA_DIR = prev
  registerClaudeLaunchSettings(() => DEFAULT_SETTINGS)
  rmSync(dir, { recursive: true, force: true })
})

describe('commandSecretWarning', () => {
  it.each([
    'claude --api-key sk-ant-api03-abcdef',
    'env ANTHROPIC_API_KEY=abc123 claude',
    'ANTHROPIC_AUTH_TOKEN=abc claude',
    'env MY_TOKEN=abc claude',
    'env SOME_KEY=abc claude',
    'curl https://user:hunter2@host.test/x',
  ])('flags %s', (c) => expect(commandSecretWarning(c)).toBe(true))
  it.each([
    'claude',
    'envman -e claude:malik-opus -- claude --model opus',
    'direnv exec . claude',
    'op run -- claude',
    'env FOO=1 claude',
    'KEY= claude',
    'https://host.test/path claude',
  ])('does not flag %s', (c) => expect(commandSecretWarning(c)).toBe(false))
})

describe('command mode model', () => {
  it('parseUpdate keeps only mode + profileId', () => {
    expect(parseUpdate({ mode: 'command', profileId: 'm', baseUrl: 'https://x.test', model: 'm', secret: KEY, credential: 'apiKey' }))
      .toEqual({ ok: true, config: { mode: 'command', profileId: 'm' } })
  })
  it('isReady needs the profile to exist; providerEnv injects and clears nothing', () => {
    expect(isReady({ mode: 'command', profileId: 'm' }, false, true)).toBe(true)
    expect(isReady({ mode: 'command', profileId: 'm' }, true, false)).toBe(false)
    expect(providerEnv({ mode: 'command', profileId: 'm' }, { url: 'http://127.0.0.1:1', token: 't' })).toEqual({ set: {}, unset: [] })
  })
})

describe('command mode store', () => {
  it('round-trips, drops old key-mode fields, keeps the stored secret, and bumps updatedAt', () => {
    saveProvider({ mode: 'custom', baseUrl: 'https://gw.example.test', credential: 'authToken', model: 'x' }, KEY, undefined, 1)
    saveProvider({ mode: 'command', profileId: 'm' }, undefined, undefined, 2)
    expect(loadConfig()).toEqual({ mode: 'command', profileId: 'm', updatedAt: 2 })
    expect(providerView()).toMatchObject({ secretSet: true, ready: true, profile: { id: 'm', command: 'envman -e claude:x -- claude' } })
    expect(commandProfileOverride()).toBe('m')
    saveProvider({ mode: 'login' }, undefined)
    expect(commandProfileOverride()).toBeUndefined()
  })
})
