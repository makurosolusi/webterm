// A claude node's recorded launch profile reaches the PTY command, through Sessions.open with an
// injected fake spawn (no real PTY). Data dir isolated by src/testIsolation.setup.ts + hoisted guard.
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ServerMsg } from '../../shared/protocol'

await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  process.env.WEBTERM_DATA_DIR ??= fs.mkdtempSync(`${os.tmpdir()}/wt-launch-sessions-`)
})

const { Sessions } = await import('../sessions')
const { FakePty } = await import('../fakePty.testutil')
const { registerClaudeLaunchSettings } = await import('./claudeLauncher')
const { DEFAULT_SETTINGS } = await import('../../shared/settings')

afterEach(() => registerClaudeLaunchSettings(() => DEFAULT_SETTINGS))

function harness() {
  const cmds: (string | undefined)[] = []
  const sessions = new Sessions({ spawn: (opts) => { cmds.push(opts.cmd); return new FakePty(4242) } })
  const out: string[] = []
  const send = (m: ServerMsg): void => { if (m.t === 'output') out.push(m.data) }
  return { sessions, cmds, out, send }
}
const open = (id: string, claudeProfileId?: string) =>
  ({ t: 'open' as const, id, cols: 80, rows: 24, agentId: 'claude' as const, cmd: 'claude', ...(claudeProfileId ? { claudeProfileId } : {}) })

describe('Sessions.open with a recorded Claude launch profile', () => {
  test('the profile command replaces the client cmd (cold restore included)', () => {
    registerClaudeLaunchSettings(() => ({ claudeLaunchProfiles: [{ id: 'm', name: 'Malik', command: 'envman -e claude:malik-opus --' }], defaultClaudeProfileId: 'm', centralClaudeProfileId: '' }))
    const h = harness()
    h.sessions.open(open('lp-1', 'm'), h.send)
    expect(h.cmds[0]?.startsWith('envman -e claude:malik-opus -- claude')).toBe(true)
    expect(h.out.join('')).not.toMatch(/no longer exists/)
  })

  test('a deleted profile launches Default and leaves a visible note on the node', () => {
    registerClaudeLaunchSettings(() => DEFAULT_SETTINGS)
    const h = harness()
    h.sessions.open(open('lp-2', 'gone'), h.send)
    expect(h.cmds[0]?.startsWith('claude')).toBe(true)
    expect(h.out.join('')).toMatch(/\[webterm\] This node's Claude launch profile no longer exists — launching with "Default"/)
  })
})
