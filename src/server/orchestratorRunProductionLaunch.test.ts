// Worker kind + launch line resolved from settings (no hard-coded `claude`).
import { describe, expect, it } from 'vitest'
import { workerLaunch } from './orchestratorRunProduction'

const launch = (agentLaunchCommands: Partial<Record<string, string>>, claudeOnPath = true) =>
  workerLaunch({ ledger: null, settings: () => ({ agentLaunchCommands }), claudeOnPath: () => claudeOnPath })

describe('workerLaunch', () => {
  it('uses the configured override as the launch line of the configured kind', async () => {
    expect(await launch({ claude: 'claude-work' })).toEqual({ agentId: 'claude', cmd: 'claude-work' })
    expect(await launch({ codex: 'codex --profile ci' })).toEqual({ agentId: 'codex', cmd: 'codex --profile ci' })
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
