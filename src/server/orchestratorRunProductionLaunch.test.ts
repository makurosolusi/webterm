// Worker kind + launch line resolved from settings (no hard-coded `claude`).
import { describe, expect, it } from 'vitest'
import { workerLaunch } from './orchestratorRunProduction'

const launch = (agentLaunchCommands: Partial<Record<string, string>>, claudeOnPath = true) =>
  workerLaunch({ ledger: null, settings: () => ({ agentLaunchCommands }), claudeOnPath: () => claudeOnPath })

describe('workerLaunch', () => {
  it('uses the configured override as the launch line of the configured kind', async () => {
    expect(await launch({ codex: 'codex --profile ci' })).toEqual({ agentId: 'codex', cmd: 'codex --profile ci' })
  })

  it('claude launches through the default profile; a chosen profile counts as configured, the legacy override does not', async () => {
    const profiles = { claudeLaunchProfiles: [{ id: 'm', name: 'M', command: 'envman -e claude:m --' }], defaultClaudeProfileId: 'm' }
    const withProfile = (claudeOnPath: boolean) =>
      workerLaunch({ ledger: null, settings: () => ({ agentLaunchCommands: { codex: 'codex' }, ...profiles }), claudeOnPath: () => claudeOnPath })
    expect(await withProfile(true)).toEqual({ agentId: 'claude', cmd: 'envman -e claude:m -- claude' })
    expect(await withProfile(false)).toEqual({ agentId: 'codex', cmd: 'codex' })
    expect(await launch({ claude: 'claude-work' })).toEqual({ agentId: 'claude', cmd: 'claude' })
  })

  it('probes the program the default profile runs first, not a bare claude', async () => {
    const run = (command: string) => workerLaunch({ ledger: null, settings: () => ({ agentLaunchCommands: {}, claudeLaunchProfiles: [{ id: 'p', name: 'P', command }], defaultClaudeProfileId: 'p' }) })
    expect(await run('/nonexistent/wt-wrapper --')).toEqual({ agentId: 'opencode', cmd: 'opencode' })
    expect(await run('/bin/echo --')).toEqual({ agentId: 'claude', cmd: '/bin/echo -- claude' })
  })

  it('keeps the builtin launcher for legacy installs and picks opencode when claude is missing (P3)', async () => {
    expect(await launch({})).toEqual({ agentId: 'claude', cmd: 'claude' })
    expect(await launch({}, false)).toEqual({ agentId: 'opencode', cmd: 'opencode' })
  })

  it('falls back to the default launcher when settings cannot be read', async () => {
    const broken = await workerLaunch({
      ledger: null,
      settings: () => {
        throw new Error('db locked')
      },
      claudeOnPath: () => false,
    })
    expect(broken).toEqual({ agentId: 'opencode', cmd: 'opencode' })
  })
})
