// Claude nodes made before launch profiles (no claudeProfileId): the stock `claude` command launches
// with the DEFAULT profile, a customised command is never overridden. Fake spawn, no real PTY.
import { afterEach, describe, expect, test, vi } from 'vitest'

await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  process.env.WEBTERM_DATA_DIR ??= fs.mkdtempSync(`${os.tmpdir()}/wt-launch-legacy-`)
})

const { Sessions } = await import('../sessions')
const { FakePty } = await import('../fakePty.testutil')
const { registerClaudeLaunchSettings } = await import('./claudeLauncher')
const { DEFAULT_SETTINGS } = await import('../../shared/settings')

afterEach(() => registerClaudeLaunchSettings(() => DEFAULT_SETTINGS))

const MALIK = { claudeLaunchProfiles: [{ id: 'm', name: 'Malik', command: 'envman -e claude:malik-opus --' }], defaultClaudeProfileId: 'm', centralClaudeProfileId: '' }

function launch(cmd: string, agentId: 'claude' | 'codex' = 'claude'): string | undefined {
  const cmds: (string | undefined)[] = []
  const sessions = new Sessions({ spawn: (opts) => { cmds.push(opts.cmd); return new FakePty(4242) } })
  sessions.open({ t: 'open', id: `legacy-${Math.random().toString(36).slice(2)}`, cols: 80, rows: 24, agentId, cmd }, () => {})
  return cmds[0]
}

describe('legacy Claude node launch', () => {
  test('stock `claude` with no profile launches the default profile (wrapper argv)', () => {
    registerClaudeLaunchSettings(() => MALIK)
    expect(launch('claude')?.startsWith('envman -e claude:malik-opus -- claude')).toBe(true)
  })

  test('a user-customised command is never overridden', () => {
    registerClaudeLaunchSettings(() => MALIK)
    expect(launch('my-claude-wrapper --fast')?.startsWith('my-claude-wrapper --fast')).toBe(true)
  })

  test('other agents are untouched', () => {
    registerClaudeLaunchSettings(() => MALIK)
    expect(launch('codex', 'codex')?.startsWith('codex')).toBe(true)
  })
})
