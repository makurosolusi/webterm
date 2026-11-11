// Staged preflight with REAL processes: fake `envman` and fake `claude` scripts on a temp PATH.
// Fake envman execs everything after `--` with ANTHROPIC_API_KEY=test-only injected, like the real one.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLAUDE_INSTALL, probeClaudeLaunch } from './claudeLaunch.probe'
import { resolveProfileLaunch } from '../../shared/claudeLaunch/claudeLaunch.profiles'
import { createClaudePreflight } from '../central/runtime/claudePreflight'
import { registerClaudeLaunchSettings } from './claudeLauncher'
import { DEFAULT_SETTINGS } from '../../shared/settings'


// Before any src/server import resolves: never touch the real data dir.
await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  process.env.WEBTERM_DATA_DIR ??= fs.mkdtempSync(`${os.tmpdir()}/wt-probe-data-`)
})

const FAKE_ENVMAN = `#!/bin/sh
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
[ "$1" = "--" ] || { echo "load x: open x: no such file or directory" >&2; exit 1; }
shift
command -v "$1" >/dev/null 2>&1 || { echo "exec: $1: executable file not found in \\$PATH" >&2; exit 127; }
ANTHROPIC_API_KEY=test-only exec "$@"
`
const FAKE_CLAUDE = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.318 (Claude Code)"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  if [ -n "$ANTHROPIC_API_KEY" ]; then echo '{"loggedIn":true,"authMethod":"api_key","apiKeySource":"ANTHROPIC_API_KEY"}'; exit 0; fi
  echo '{"loggedIn":false,"authMethod":"none"}'; exit 1
fi
exit 2
`
const FAILING_ENVMAN = `#!/bin/sh
echo "auth failed for token sk-ant-api03-SECRETSECRETSECRET1234" >&2
exit 3
`

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
function bin(files: Record<string, string>): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'cl-'))
  dirs.push(dir)
  for (const [name, body] of Object.entries(files)) { writeFileSync(join(dir, name), body); chmodSync(join(dir, name), 0o755) }
  return { PATH: `${dir}:/usr/bin:/bin` }
}
const profile = (command: string) => resolveProfileLaunch({ claudeLaunchProfiles: [{ id: 'p', name: 'Malik', command }], defaultClaudeProfileId: 'p', centralClaudeProfileId: '' })
const login = { mode: 'login', ready: true }

describe('probeClaudeLaunch (real fake bins)', () => {
  it('envman-injected credential counts as signed in', async () => {
    const r = await probeClaudeLaunch(profile('envman -e claude:malik-opus --'), { env: bin({ envman: FAKE_ENVMAN, claude: FAKE_CLAUDE }), provider: login })
    expect(r.ok).toBe(true)
    expect(r.profile).toEqual({ id: 'p', name: 'Malik' })
    expect(r.steps.map((s) => [s.stage, s.ok])).toEqual([['wrapper', true], ['claude', true], ['auth', true]])
    expect(r.steps[1]?.message).toBe('claude 2.1.318 (Claude Code)')
    expect(r.steps[2]?.message).toMatch(/credential from the environment \(api_key\)/)
    expect(JSON.stringify(r)).not.toContain('test-only')
  })

  it('bare claude without the wrapper is NOT signed in (the bug this fixes)', async () => {
    const r = await probeClaudeLaunch(profile(''), { env: bin({ claude: FAKE_CLAUDE }), provider: login })
    expect(r).toMatchObject({ ok: false, failed: 'auth_failed' })
    expect(r.steps.at(-1)).toMatchObject({ stage: 'auth', ok: false, hint: 'Run "claude auth login" on the server.' })
  })

  it('wrapper missing: names the binary', async () => {
    const r = await probeClaudeLaunch(profile('envman -e x -- claude'), { env: bin({ claude: FAKE_CLAUDE }), provider: login })
    expect(r).toMatchObject({ ok: false, failed: 'wrapper_not_found' })
    expect(r.steps).toEqual([{ stage: 'wrapper', ok: false, message: 'envman not found on PATH', hint: expect.any(String) }])
  })

  it('wrapper exits non-zero: shows its first stderr line, redacted', async () => {
    const r = await probeClaudeLaunch(profile('envman -e x -- claude'), { env: bin({ envman: FAILING_ENVMAN, claude: FAKE_CLAUDE }), provider: login })
    expect(r).toMatchObject({ ok: false, failed: 'wrapper_failed' })
    const msg = r.steps[0]?.message ?? ''
    expect(msg).toMatch(/^envman exited with code 3: auth failed for token /)
    expect(msg).not.toContain('SECRETSECRET')
  })

  it('claude missing behind the wrapper', async () => {
    const r = await probeClaudeLaunch(profile('envman -e x -- claude'), { env: bin({ envman: FAKE_ENVMAN }), provider: login })
    expect(r).toMatchObject({ ok: false, failed: 'claude_not_found' })
    expect(r.steps.map((s) => [s.stage, s.ok])).toEqual([['wrapper', true], ['claude', false]])
    expect(r.steps.at(-1)?.install).toEqual(CLAUDE_INSTALL)
  })

  it('claude missing (no wrapper): the step carries the official install commands for a copy button', async () => {
    const r = await probeClaudeLaunch(profile(''), { env: bin({}), provider: login })
    expect(r).toMatchObject({ ok: false, failed: 'claude_not_found' })
    expect(r.steps).toEqual([{ stage: 'claude', ok: false, message: expect.stringContaining(CLAUDE_INSTALL.installCommand), hint: expect.stringContaining(CLAUDE_INSTALL.npmCommand), install: CLAUDE_INSTALL }])
    expect(CLAUDE_INSTALL.installCommand).toBe('curl -fsSL https://claude.ai/install.sh | bash')
    expect(CLAUDE_INSTALL.npmCommand).toBe('npm install -g @anthropic-ai/claude-code')
  })

  it('only the claude-missing step carries install commands', async () => {
    const r = await probeClaudeLaunch(profile(''), { env: bin({ claude: FAKE_CLAUDE }), provider: login })
    expect(r.steps.some((s) => s.install)).toBe(false)
  })

  it('a missing -- is normalised before running, so it still works', async () => {
    const r = await probeClaudeLaunch(profile('envman -e x claude'), { env: bin({ envman: FAKE_ENVMAN, claude: FAKE_CLAUDE }), provider: login })
    expect(r.ok).toBe(true)
  })
})

describe('createClaudePreflight runs through the Central profile', () => {
  afterEach(() => registerClaudeLaunchSettings(() => DEFAULT_SETTINGS))
  it('ready via envman; reports stage + profile when the wrapper is missing', async () => {
    registerClaudeLaunchSettings(() => ({ claudeLaunchProfiles: [{ id: 'm', name: 'Malik', command: 'envman -e claude:malik-opus --' }], defaultClaudeProfileId: 'default', centralClaudeProfileId: 'm' }))
    const ok = await createClaudePreflight({ env: bin({ envman: FAKE_ENVMAN, claude: FAKE_CLAUDE }), provider: () => login as never })()
    expect(ok).toEqual({ ok: true })
    const bad = await createClaudePreflight({ env: bin({ claude: FAKE_CLAUDE }), provider: () => login as never })()
    expect(bad).toMatchObject({ ok: false, code: 'claude_check_failed', stage: 'wrapper', failed: 'wrapper_not_found', profile: { name: 'Malik' } })
    expect(bad.ok === false && bad.hint).toMatch(/^envman not found on PATH\. Install it/)
  })
})
