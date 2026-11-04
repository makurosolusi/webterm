import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activeProviderEnv, claudeEnv, loadConfig, providerDir, providerView, saveProvider } from './claudeProvider.store'
import { STALE_LAUNCH_MS, wrapClaudeLaunch } from './claudeProvider.launch'
import { providerEnv } from './claudeProvider.model'

const KEY = 'sk-test-only-0123456789abcdef' // test-only
let dir = ''
let prevDataDir: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cp-store-'))
  prevDataDir = process.env.WEBTERM_DATA_DIR
  process.env.WEBTERM_DATA_DIR = join(dir, 'data') // own data dir: parallel test files never see this provider
})
afterEach(() => {
  process.env.WEBTERM_DATA_DIR = prevDataDir
  rmSync(dir, { recursive: true, force: true })
})

describe('provider store', () => {
  it('defaults to the login with no files and no env change', () => {
    expect(loadConfig()).toEqual({ mode: 'login' })
    expect(activeProviderEnv()).toEqual({ set: {}, unset: [] })
    expect(claudeEnv({ PATH: '/bin' })).toEqual({ PATH: '/bin' })
  })

  it('keeps the secret in its own 0600 file, never in the config file or the view', () => {
    saveProvider({ mode: 'apiKey' }, KEY, undefined, 42)
    const files = readdirSync(providerDir())
    expect(files.sort()).toEqual(['CONFIG', 'SECRET'])
    for (const f of files) expect(statSync(join(providerDir(), f)).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(providerDir(), 'CONFIG'), 'utf8')).not.toContain(KEY)
    const view = providerView()
    expect(view).toEqual({ mode: 'apiKey', updatedAt: 42, secretSet: true, ready: true })
    expect(JSON.stringify(view)).not.toContain(KEY)
    expect(claudeEnv({ ANTHROPIC_AUTH_TOKEN: 'inherited' }).ANTHROPIC_API_KEY).toBe(KEY)
  })

  it('secret undefined keeps it, null removes it (mode stays, not ready)', () => {
    saveProvider({ mode: 'apiKey' }, KEY)
    saveProvider({ mode: 'apiKey', model: 'claude-sonnet-4-6' }, undefined)
    expect(providerView().secretSet).toBe(true)
    saveProvider({ mode: 'apiKey' }, null)
    expect(providerView()).toMatchObject({ secretSet: false, ready: false })
    expect(activeProviderEnv()).toEqual({ set: {}, unset: [] })
  })

  it('a hand-broken config falls back to the login', () => {
    saveProvider({ mode: 'apiKey' }, KEY)
    writeFileSync(join(providerDir(), 'CONFIG'), '{not json', { mode: 0o600 })
    expect(loadConfig()).toEqual({ mode: 'login' })
  })
})

describe('wrapClaudeLaunch (agent PTY)', () => {
  const pe = () => providerEnv({ mode: 'custom', baseUrl: 'https://gw.example.test', credential: 'authToken' }, KEY)

  it('login mode leaves the command untouched and writes no file', () => {
    const launchDir = join(dir, 'launch')
    expect(wrapClaudeLaunch('claude --x', { set: {}, unset: [] }, '/bin/sh', launchDir)).toBe('claude --x')
    expect(existsSync(launchDir)).toBe(false)
  })

  it('the key never appears in the command line; the one-shot file is 0600', () => {
    const launchDir = join(dir, 'launch')
    const cmd = wrapClaudeLaunch('claude --x', pe(), '/bin/sh', launchDir)
    expect(cmd).not.toContain(KEY)
    expect(cmd).toMatch(/^\/bin\/sh '.+\.sh'$/)
    const [file] = readdirSync(launchDir)
    expect(statSync(join(launchDir, file!)).mode & 0o777).toBe(0o600)
  })

  it('really runs: the command sees the provider env, an inherited API key is gone, the file deletes itself', () => {
    const launchDir = join(dir, 'launch')
    const probe = 'printf "%s|%s|%s|%s" "${#ANTHROPIC_AUTH_TOKEN}" "$ANTHROPIC_BASE_URL" "${ANTHROPIC_API_KEY-unset}" "$CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"'
    const cmd = wrapClaudeLaunch(probe, pe(), '/bin/sh', launchDir)
    const out = execFileSync('/bin/sh', ['-c', cmd], { env: { PATH: '/usr/bin:/bin', ANTHROPIC_API_KEY: 'inherited-test-only' }, encoding: 'utf8' })
    expect(out).toBe(`${KEY.length}|https://gw.example.test|unset|1`)
    expect(readdirSync(launchDir)).toEqual([])
  })

  it('sweeps launch files a failed spawn never consumed', () => {
    const launchDir = join(dir, 'launch')
    wrapClaudeLaunch('true', pe(), '/bin/sh', launchDir)
    const [stale] = readdirSync(launchDir)
    const old = (Date.now() - STALE_LAUNCH_MS - 1000) / 1000
    utimesSync(join(launchDir, stale!), old, old)
    wrapClaudeLaunch('true', pe(), '/bin/sh', launchDir)
    expect(readdirSync(launchDir)).not.toContain(stale)
    expect(readdirSync(launchDir)).toHaveLength(1)
  })
})
