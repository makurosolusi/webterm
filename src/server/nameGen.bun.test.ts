// agent-211-A3 lock: AI naming really reaches the CLI. It used Bun.spawn with a string `stdin`, which
// Bun rejects, and a bare catch hid the error, so every call fell back or failed with no title. A fake
// `claude` (a script registered as the Central launch profile) proves the prompt arrives on stdin, a
// hang settles with the timeout, and the child sees the filtered env (sec-208-7). Never runs real Claude.
import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'wt-namegen-'))
const SAVED = { SHELL: process.env.SHELL, WEBTERM_DATA_DIR: process.env.WEBTERM_DATA_DIR, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }
process.env.WEBTERM_DATA_DIR = join(root, 'data')
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude')
process.env.SHELL = '/bin/sh'
/** test-only canary: a WEBTERM_* var the naming child must never see. */
const CANARY = 'WEBTERM_NAMEGEN_CANARY_227'
process.env[CANARY] = 'present'

const { registerClaudeLaunchSettings } = await import('./claudeLauncher/claudeLauncher')
const { DEFAULT_SETTINGS } = await import('../shared/settings')
const { sessions } = await import('./sessions')
const { generateName } = await import('./nameGen')

const fakes = sessions as unknown as Record<string, unknown>
fakes.getTranscript = (): undefined => undefined
fakes.getTerminal = (): string => '$ npm run dev\nlistening on :5173'

afterAll(() => {
  delete fakes.getTranscript // back to the prototype methods
  delete fakes.getTerminal
  registerClaudeLaunchSettings(() => DEFAULT_SETTINGS)
  for (const [k, v] of Object.entries(SAVED)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  delete process.env[CANARY]
  rmSync(root, { recursive: true, force: true })
})

/** Register `body` as the claude command (the naming line appends ` -p`). */
function fakeClaude(name: string, body: string): string {
  const p = join(root, name)
  writeFileSync(p, `#!/bin/sh\n${body}\n`)
  chmodSync(p, 0o755)
  registerClaudeLaunchSettings(() => ({ ...DEFAULT_SETTINGS, claudeLaunchProfiles: [{ id: 'fake', name: 'Fake', command: p }], defaultClaudeProfileId: 'fake', centralClaudeProfileId: 'fake' }))
  return p
}

describe('generateName runs the CLI with the prompt on stdin (agent-211-A3)', () => {
  test('the title comes from the CLI, which read the prompt from stdin and saw no server var', async () => {
    fakeClaude('claude-ok', [
      'input=$(cat)',
      `leak=\${${CANARY}:+ Leaked}`,
      'case "$input" in *"npm run dev"*) echo "Dev Server$leak";; *) echo "No Stdin$leak";; esac',
    ].join('\n'))
    expect(await generateName('n1')).toEqual({ ok: true, message: 'Dev Server' })
  })

  test('a hanging CLI settles at the timeout and its process group is killed', async () => {
    const pidFile = join(root, 'hang.pid')
    fakeClaude('claude-hang', `echo $$ > "${pidFile}"\nsleep 30`)
    const started = Date.now()
    // 3s, not less: the timeout includes `sh -l` startup, and a shorter one can kill the shell before
    // the fake writes its pid file (seen under a fresh HOME in test:bun).
    const r = await generateName('n1', 3000)
    expect(Date.now() - started < 10_000).toBe(true)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('timed out')
    const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : 0
    expect(pid > 0).toBe(true)
    const alive = (): boolean => {
      try { process.kill(pid, 0); return true } catch { return false } // ESRCH = the hung child is gone, which is the point
    }
    // An orphaned grandchild is reaped by init a moment after the group kill.
    for (let i = 0; i < 20 && alive(); i++) await new Promise((r) => setTimeout(r, 50))
    expect(alive()).toBe(false)
  })

  test('a missing claude command names the cause instead of a generic failure', async () => {
    registerClaudeLaunchSettings(() => ({ ...DEFAULT_SETTINGS, claudeLaunchProfiles: [{ id: 'fake', name: 'Fake', command: join(root, 'no-such-claude') }], defaultClaudeProfileId: 'fake', centralClaudeProfileId: 'fake' }))
    const r = await generateName('n1')
    expect(r.ok).toBe(false)
    expect(r.message).toContain('could not find the claude command')
  })
})
