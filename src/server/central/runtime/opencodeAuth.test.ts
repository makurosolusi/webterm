import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOpencodePreflight, hasProviderCredential, providerOf, type OcRunFn } from './opencodeAuth'

let dir = ''
let userHome = ''
let childHome = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'opencode-auth-'))
  userHome = join(dir, 'user-home')
  childHome = join(dir, 'child-home')
  // test-only: the user's opencode config/plugins, which must never reach the child home.
  mkdirSync(join(userHome, '.config', 'opencode', 'plugins'), { recursive: true })
  writeFileSync(join(userHome, '.config', 'opencode', 'opencode.json'), '{"plugin":["evil"]}')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const CRED = '[{"id":"cred_1","integrationID":"opencode","value":{"type":"api","key":"test-only-key"}}]'

/**
 * Fake `opencode`: `auth export` prints CRED only from the user HOME; `auth import` stores stdin
 * (mode 0600) under the child's XDG_DATA_HOME; `auth list` lists what was imported. Logs argv + HOME.
 */
function fakeOpencode(): { bin: string; calls: () => Array<{ argv: string[]; home: string }> } {
  const callsFile = join(dir, 'calls.jsonl')
  const bin = join(dir, 'fake-opencode.mjs')
  writeFileSync(bin, `#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
const argv = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ argv, home: process.env.HOME }) + '\\n')
const store = path.join(process.env.XDG_DATA_HOME ?? path.join(process.env.HOME, '.local', 'share'), 'opencode', 'creds.json')
if (argv[1] === 'export') {
  if (process.env.HOME !== ${JSON.stringify(userHome)}) process.exit(1)
  process.stdout.write(${JSON.stringify(CRED)})
} else if (argv[1] === 'import') {
  const input = fs.readFileSync(0, 'utf8')
  fs.mkdirSync(path.dirname(store), { recursive: true })
  fs.writeFileSync(store, input, { mode: 0o600 })
} else if (argv[1] === 'list') {
  const creds = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, 'utf8')) : []
  const ids = [...new Set(creds.map((c) => c.integrationID))]
  process.stdout.write(JSON.stringify(ids.map((id) => ({ id, connections: creds.filter((c) => c.integrationID === id) }))))
}
`, { mode: 0o755 })
  chmodSync(bin, 0o755)
  const calls = () => existsSync(callsFile)
    ? readFileSync(callsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { argv: string[]; home: string })
    : []
  return { bin, calls }
}

function deps(executable: string, extra: Partial<Parameters<typeof createOpencodePreflight>[0]> = {}) {
  return {
    executable,
    model: 'opencode/deepseek-v4.1-flash-free',
    homeDir: childHome,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: userHome },
    cwd: dir,
    ...extra,
  }
}

describe('opencode credential bridge', () => {
  it('moves only the provider credentials into the isolated home, never the config', async () => {
    const { bin, calls } = fakeOpencode()
    const ready = await createOpencodePreflight(deps(bin))()

    expect(ready).toEqual({ ok: true })
    const store = join(childHome, '.local', 'share', 'opencode', 'creds.json')
    expect(readFileSync(store, 'utf8')).toBe(CRED)
    expect(statSync(store).mode & 0o777).toBe(0o600)
    // The isolated config dir exists but is empty: no opencode.json, no plugins.
    expect(readdirSync(join(childHome, '.config'))).toEqual([])
    const seen = calls()
    expect(seen.map((c) => c.argv)).toEqual([
      ['auth', 'export', '--standalone', 'opencode'],
      ['auth', 'import', '--standalone'],
      ['auth', 'list', '--standalone', '--format', 'json'],
    ])
    expect(seen.map((c) => c.home)).toEqual([userHome, childHome, childHome])
  })

  it('is not-ready with a clear reason when the provider has no credential', async () => {
    const { bin } = fakeOpencode()
    const ready = await createOpencodePreflight(deps(bin, { model: 'anthropic/claude-x' }))()
    expect(ready).toMatchObject({ ok: false, code: 'opencode_model_unavailable' })
    expect(ready.ok ? '' : ready.reason).toContain('model "anthropic/claude-x" unavailable')
  })

  it('reports a missing executable as opencode_not_found', async () => {
    const ready = await createOpencodePreflight(deps(join(dir, 'missing-opencode')))()
    expect(ready).toMatchObject({ ok: false, code: 'opencode_not_found' })
  })

  it('caches ready for the long TTL and not-ready for the short one', async () => {
    let t = 0
    let listed = 0
    let present = false
    const run: OcRunFn = async (_exe, args) => {
      if (args[1] === 'list') listed += 1
      return { code: 0, timedOut: false, stdout: args[1] === 'list' && present ? '[{"id":"opencode","connections":[{}]}]' : '' }
    }
    const probe = createOpencodePreflight({ ...deps('opencode'), run, now: () => t })
    expect((await probe()).ok).toBe(false)
    t = 10_000
    await probe()
    expect(listed).toBe(1)
    present = true
    t = 31_000
    expect((await probe()).ok).toBe(true)
    t = 31_000 + 4 * 60_000
    await probe()
    expect(listed).toBe(2)
  })
})

describe('opencode auth parsing', () => {
  it('reads the provider prefix and connection presence', () => {
    expect(providerOf('opencode/deepseek#fast')).toBe('opencode')
    expect(hasProviderCredential('[{"id":"opencode","connections":[{"id":"c"}]}]', 'opencode')).toBe(true)
    expect(hasProviderCredential('[{"id":"opencode","connections":[]}]', 'opencode')).toBe(false)
    expect(hasProviderCredential('not json', 'opencode')).toBe(false)
  })
})
