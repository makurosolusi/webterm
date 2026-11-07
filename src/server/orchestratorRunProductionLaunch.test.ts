// Worker kind + launch line resolved from settings (no hard-coded `claude`).
import { describe, expect, it } from 'vitest'
import { workerLaunch } from './orchestratorRunProduction'

const launch = (claudeOnPath = true) =>
  workerLaunch({ ledger: null, settings: () => ({}), claudeOnPath: () => claudeOnPath })

describe('workerLaunch', () => {
  it('claude launches through the default profile; without claude there is no worker', async () => {
    const profiles = { claudeLaunchProfiles: [{ id: 'm', name: 'M', command: 'envman -e claude:m --' }], defaultClaudeProfileId: 'm' }
    const withProfile = (claudeOnPath: boolean) =>
      workerLaunch({ ledger: null, settings: () => profiles, claudeOnPath: () => claudeOnPath })
    expect(await withProfile(true)).toEqual({ agentId: 'claude', cmd: 'envman -e claude:m -- claude' })
    expect(await withProfile(false)).toBeNull()
  })

  it('probes the program the default profile runs first, not a bare claude', async () => {
    const run = (command: string) => workerLaunch({ ledger: null, settings: () => ({ claudeLaunchProfiles: [{ id: 'p', name: 'P', command }], defaultClaudeProfileId: 'p' }) })
    expect(await run('/nonexistent/wt-wrapper --')).toBeNull()
    expect(await run('/bin/echo --')).toEqual({ agentId: 'claude', cmd: '/bin/echo -- claude' })
  })

  it('keeps the builtin launcher, and without claude answers null (Claude needed), never opencode', async () => {
    expect(await launch()).toEqual({ agentId: 'claude', cmd: 'claude' })
    expect(await launch(false)).toBeNull()
  })

  it('falls back to the default launcher when settings cannot be read', async () => {
    const broken = await workerLaunch({
      ledger: null,
      settings: () => {
        throw new Error('db locked')
      },
      claudeOnPath: () => false,
    })
    expect(broken).toBeNull()
  })
})
