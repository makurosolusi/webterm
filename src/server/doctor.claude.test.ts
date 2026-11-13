// Doctor's Claude check through the REAL wiring (doctor.runtime.ts -> the shared Claude startup resolver ->
// probe), per provider mode, with fake `claude` / `envman` scripts on a temp PATH. Never the real claude.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS } from '../shared/settings'
import type { DoctorCheck } from './doctor'

// Fake claude: signed in only when a credential is in its env (what a wrapper such as envman injects).
const FAKE_CLAUDE = `#!/bin/sh
case " $* " in *" --version "*) echo "2.1.0 (Claude Code)"; exit 0 ;; esac
if [ "$1" = auth ]; then
  if [ -n "$ANTHROPIC_API_KEY" ]; then echo '{"loggedIn":true,"authMethod":"api_key"}'; exit 0; fi
  echo '{"loggedIn":false,"authMethod":"none"}'; exit 1
fi
exit 0
`
// Fake envman: drops its own options up to `--`, injects a credential, execs the rest.
const FAKE_ENVMAN = `#!/bin/sh
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift
ANTHROPIC_API_KEY=test-only-fake-key exec "$@"
`
const LOGIN_HINT = /claude auth login/

let root = ''
let bin = ''
const saved: Record<string, string | undefined> = {}
type Mods = {
  runDoctor: typeof import('./doctor').runDoctor
  doctorDeps: typeof import('./doctor.runtime').doctorDeps
  launcher: typeof import('./claudeLauncher/claudeLauncher')
  store: typeof import('./claudeProvider/claudeProvider.store')
}
let m: Mods

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'doctor-claude-'))
  for (const k of ['WEBTERM_DATA_DIR', 'HOME', 'CLAUDE_CONFIG_DIR']) saved[k] = process.env[k]
  process.env.HOME = join(root, 'home')
  process.env.CLAUDE_CONFIG_DIR = join(root, 'home', '.claude')
  mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
  // Imported after the env points at temp dirs: nothing may read the real data dir or ~/.claude.
  m = {
    runDoctor: (await import('./doctor')).runDoctor,
    doctorDeps: (await import('./doctor.runtime')).doctorDeps,
    launcher: await import('./claudeLauncher/claudeLauncher'),
    store: await import('./claudeProvider/claudeProvider.store'),
  }
})
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  const run = mkdtempSync(join(root, 'run-'))
  process.env.WEBTERM_DATA_DIR = join(run, 'data')
  bin = join(run, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE)
  chmodSync(join(bin, 'claude'), 0o755)
  m.launcher.registerClaudeLaunchSettings(() => ({
    ...DEFAULT_SETTINGS, claudeLaunchProfiles: [{ id: 'malik', name: 'Malik', command: 'envman -e claude:malik -- claude' }],
  }))
  // As db.ts wires it in the server.
  m.launcher.registerDefaultProfileOverride(() => m.store.commandProfileOverride())
})
afterEach(() => {
  m.launcher.registerClaudeLaunchSettings(() => DEFAULT_SETTINGS)
  m.launcher.registerDefaultProfileOverride(() => undefined)
})

const withEnvman = (): void => {
  writeFileSync(join(bin, 'envman'), FAKE_ENVMAN)
  chmodSync(join(bin, 'envman'), 0o755)
}
const service = { update: () => ({ ok: true }) } as unknown as Parameters<Mods['doctorDeps']>[0]['service']
async function claudeCheck(): Promise<DoctorCheck> {
  const deps = m.doctorDeps({ service, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: process.env.HOME as string } })
  const checks = await m.runDoctor(deps)
  return checks.find((c) => c.id === 'claude') as DoctorCheck
}

describe('Doctor Claude check per provider mode', () => {
  it('Claude login, signed out: fails with the login hint', async () => {
    const c = await claudeCheck()
    expect(c.status).toBe('fail')
    expect(c.detail).toMatch(/^Not ready via Claude Code login: /)
    expect(c.detail).toMatch(LOGIN_HINT)
  })

  it('Command with a wrapper that injects the credential: ready via the wrapper, no login hint', async () => {
    withEnvman()
    m.store.saveProvider({ mode: 'command', profileId: 'malik' }, undefined)
    const c = await claudeCheck()
    expect(c).toMatchObject({ status: 'ok' })
    expect(c.detail).toMatch(/^Ready via envman/)
    expect(c.detail).not.toMatch(LOGIN_HINT)
  })

  it('Command whose wrapper is missing: names the wrapper, no login hint', async () => {
    m.store.saveProvider({ mode: 'command', profileId: 'malik' }, undefined)
    const c = await claudeCheck()
    expect(c.status).not.toBe('ok')
    expect(c.detail).toMatch(/^Not ready: envman not found on PATH/)
    expect(c.detail).not.toMatch(LOGIN_HINT)
  })

  it('Command whose wrapper gives no credential: fails without the login hint', async () => {
    writeFileSync(join(bin, 'envman'), '#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n')
    chmodSync(join(bin, 'envman'), 0o755)
    m.store.saveProvider({ mode: 'command', profileId: 'malik' }, undefined)
    const c = await claudeCheck()
    expect(c.status).toBe('fail')
    expect(c.detail).toMatch(/^Not ready via envman \(launch profile "Malik"\): envman started claude without a credential/)
    expect(c.detail).not.toMatch(LOGIN_HINT)
  })

  it('API key and gateway: no login hint, signed out or not', async () => {
    m.store.saveProvider({ mode: 'apiKey' }, 'test-only-key-123456')
    const key = await claudeCheck()
    expect(key.detail).toMatch(/Anthropic API key/)
    expect(key.detail).not.toMatch(LOGIN_HINT)
    m.store.saveProvider({ mode: 'custom', baseUrl: 'https://gw.example.test', credential: 'authToken' }, 'test-only-key-123456')
    const gw = await claudeCheck()
    expect(gw.detail).toMatch(/gw\.example\.test/)
    expect(gw.detail).not.toMatch(LOGIN_HINT)
    m.store.saveProvider({ mode: 'apiKey' }, null)
    const noKey = await claudeCheck()
    expect(noKey.status).toBe('fail')
    expect(noKey.detail).not.toMatch(LOGIN_HINT)
  })
})
