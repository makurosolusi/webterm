// Every server path that runs Claude goes through the launch profile: REAL processes, a fake `envman`
// that execs everything after `--` with ENVMAN_INJECTED=test-only, and a fake `claude` that logs its
// argv and that variable. Proves the wrapper ran with the profile's args and claude got the env.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { registerClaudeLaunchSettings } from './claudeLauncher'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { ClaudeRuntime } from '../central/runtime/claudeRuntime'
import { createCentralMcpLink } from '../central/runtime/claudeMcp'
import { recorder, turnInput } from '../central/runtime/claude.fakeBin'
import { createClaudeStructured } from '../central/context/claudeStructured'
import { createClaudeClassifier } from '../policy/policy.classifier.claude'
import { createClaudeConsolidatorModel } from '../memory/consolidator/consolidator.runner'
import { createAgentSpawner } from '../spawn/agentSpawn'
import { detectAgentEngine, launchLabel } from '../central/runtime/runtimeDetect'
import { centralClaudeLaunch } from './claudeLauncher'
import { nameGenLine } from '../nameGen'

// Before any src/server import resolves: never touch the real data dir.
const dataDir = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  process.env.WEBTERM_DATA_DIR = fs.mkdtempSync(`${os.tmpdir()}/wt-paths-data-`)
  return process.env.WEBTERM_DATA_DIR
})
afterAll(() => rmSync(dataDir, { recursive: true, force: true }))

const fakeEnvman = (log: string): string => `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift
ENVMAN_INJECTED=test-only exec "$@"
`
const fakeClaude = (log: string): string => `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.318 (Claude Code)"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  if [ -n "$ENVMAN_INJECTED" ]; then echo '{"loggedIn":true,"authMethod":"api_key"}'; exit 0; fi
  echo '{"loggedIn":false,"authMethod":"none"}'; exit 1
fi
printf '%s|env=%s\\n' "$1 $2" "$ENVMAN_INJECTED" >> '${log}'
cat >/dev/null
echo '{"subtype":"success","structured_output":{"decision":"allow","reason":"ok"}}'
`

let dir = ''
let PATH = ''
const prevPath = process.env.PATH
const envmanLog = (): string[] => readFileSync(join(dir, 'envman.log'), 'utf8').trim().split('\n')
const claudeLog = (): string[] => (existsSync(join(dir, 'claude.log')) ? readFileSync(join(dir, 'claude.log'), 'utf8').trim().split('\n') : [])

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cl-paths-'))
  for (const [name, body] of [['envman', fakeEnvman(join(dir, 'envman.log'))], ['claude', fakeClaude(join(dir, 'claude.log'))]] as const) {
    writeFileSync(join(dir, name), body)
    chmodSync(join(dir, name), 0o755)
  }
  PATH = `${dir}:/usr/bin:/bin`
  registerClaudeLaunchSettings(() => ({
    ...DEFAULT_SETTINGS,
    claudeLaunchProfiles: [
      { id: 'm', name: 'Malik', command: 'envman -e claude:malik-opus -- claude' },
      { id: 'o', name: 'Other', command: 'envman -e claude:other -- claude' },
    ],
    defaultClaudeProfileId: 'm', centralClaudeProfileId: '',
  }))
})
afterEach(() => {
  registerClaudeLaunchSettings(() => DEFAULT_SETTINGS)
  process.env.PATH = prevPath
  rmSync(dir, { recursive: true, force: true })
})

describe('Central paths use the Central launch profile', () => {
  it('Central runtime turn: envman wraps claude, its env reaches claude', async () => {
    await new ClaudeRuntime({
      workDir: join(dir, 'work'), newSessionId: () => 'sid', env: { PATH, HOME: dir },
      mcp: createCentralMcpLink({ dir: join(dir, 'mcp'), port: 1, mint: () => ({ token: 'wcap_test-only', revoke: () => undefined }) }), // test-only
    }).turn(turnInput(), recorder().emit)
    // The Agent SDK's args follow the profile argv (claudeSdkSpawn).
    expect(envmanLog()[0]).toMatch(/^-e claude:malik-opus -- claude --output-format stream-json /)
    expect(claudeLog()).toEqual(['--output-format stream-json|env=test-only'])
  })

  it('summarizer, policy classifier and memory consolidator (claude -p)', async () => {
    process.env.PATH = PATH // these derive the child env from process.env
    const signal = new AbortController().signal
    await createClaudeStructured('checkpoint')({ prompt: 'x', schema: {} }, signal)
    await createClaudeClassifier()({ tool: 'Bash', input: {} } as never, signal)
    await createClaudeConsolidatorModel()({ prompt: 'x', schema: {} }, signal)
    expect(envmanLog()).toHaveLength(3)
    for (const line of envmanLog()) expect(line).toMatch(/^-e claude:malik-opus -- claude -p --output-format json /)
    expect(claudeLog()).toEqual(Array(3).fill('-p --output-format|env=test-only'))
  })

  it('name generation shell line', () => {
    expect(nameGenLine()).toBe('envman -e claude:malik-opus -- claude -p')
    const r = spawnSync('/bin/sh', ['-c', nameGenLine()], { env: { PATH }, input: 'name this', encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(claudeLog()).toEqual(['-p |env=test-only'])
  })
})

describe('headless spawns use the default profile, or the one in the request', () => {
  const spawner = () => createAgentSpawner({
    providerEnv: () => ({ set: {}, unset: [] }), ancestors: () => [], registerSpawn: () => {}, record: () => {}, onPtyExit: () => {},
  })
  it('default profile; a request profile wins', async () => {
    const s = spawner()
    for (const claudeProfileId of [undefined, 'o']) {
      const r = await s.spawn({ door: 'routine', mode: 'headless', parent: 'routine:r1', cwd: dir, prompt: 'go', headless: { env: { PATH, HOME: dir }, ...(claudeProfileId ? { claudeProfileId } : {}) } })
      if (!r.ok) throw new Error(r.message)
      expect((await r.handle?.done)?.exitCode).toBe(0)
    }
    expect(envmanLog()).toEqual([
      '-e claude:malik-opus -- claude -p go --output-format json',
      '-e claude:other -- claude -p go --output-format json',
    ])
    expect(claudeLog()).toEqual(Array(2).fill('-p go|env=test-only'))
  })
})

describe('detection is profile-aware', () => {
  it('needs the wrapper on PATH and labels it', () => {
    expect(detectAgentEngine({ PATH })).toBe('claude')
    rmSync(join(dir, 'envman'))
    expect(detectAgentEngine({ PATH })).toBe('off') // claude alone does not count: the profile runs envman
    expect(launchLabel(centralClaudeLaunch())).toBe('envman (via profile Malik)')
  })
})

describe('Doctor probes the default profile', () => {
  it('ready via envman, named in the result; missing wrapper is reported as missing', async () => {
    const { doctorDeps } = await import('../doctor.runtime')
    const deps = (): ReturnType<typeof doctorDeps> => doctorDeps({ service: {} as never, env: { PATH, HOME: dir } })
    expect(await deps().claudeReady()).toEqual({ ok: true, via: 'envman (via profile Malik)' })
    rmSync(join(dir, 'envman'))
    expect(await deps().claudeReady()).toMatchObject({ ok: false, missing: true, via: 'envman (via profile Malik)', reason: expect.stringMatching(/^envman not found on PATH\./) })
  })
})
