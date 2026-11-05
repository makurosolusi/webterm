// Provider command mode makes its launch profile the default for new agents, Central and helpers;
// an explicit node profile still wins, and a deleted profile falls back to Default.
import { afterEach, describe, expect, it } from 'vitest'
import { applyNodeClaudeProfile, centralClaudeLaunch, claudeCommand, registerClaudeLaunchSettings, registerDefaultProfileOverride, resolveClaudeLaunch } from './claudeLauncher'
import { DEFAULT_SETTINGS } from '../../shared/settings'

const SETTINGS = {
  claudeLaunchProfiles: [
    { id: 'a', name: 'A', command: 'envman -e claude:a -- claude' },
    { id: 'b', name: 'B', command: 'envman -e claude:b -- claude' },
  ],
  defaultClaudeProfileId: 'default',
  centralClaudeProfileId: '',
}
afterEach(() => {
  registerClaudeLaunchSettings(() => DEFAULT_SETTINGS)
  registerDefaultProfileOverride(() => undefined)
})

describe('default profile override', () => {
  it('default, Central (empty) and helpers follow it', () => {
    registerClaudeLaunchSettings(() => SETTINGS)
    registerDefaultProfileOverride(() => 'a')
    expect(resolveClaudeLaunch().profile.id).toBe('a')
    expect(centralClaudeLaunch().profile.id).toBe('a')
    expect(claudeCommand(['-p', 'x'])).toEqual(['envman', '-e', 'claude:a', '--', 'claude', '-p', 'x'])
  })
  it('an explicit Central profile and an explicit node profile keep theirs', () => {
    registerClaudeLaunchSettings(() => ({ ...SETTINGS, centralClaudeProfileId: 'b' }))
    registerDefaultProfileOverride(() => 'a')
    expect(centralClaudeLaunch().profile.id).toBe('b')
    expect(resolveClaudeLaunch('b').profile.id).toBe('b')
    expect(applyNodeClaudeProfile({ agentId: 'claude', cmd: 'claude', claudeProfileId: 'b' }).msg.cmd).toBe('envman -e claude:b -- claude')
  })
  it('a node recorded with the settings default follows command mode; another explicit id does not', () => {
    const cmdOf = (claudeProfileId: string) => applyNodeClaudeProfile({ agentId: 'claude', cmd: 'claude', claudeProfileId }).msg.cmd
    registerClaudeLaunchSettings(() => SETTINGS)
    registerDefaultProfileOverride(() => 'a')
    expect(cmdOf('default')).toBe('envman -e claude:a -- claude')
    expect(cmdOf('b')).toBe('envman -e claude:b -- claude')
    registerClaudeLaunchSettings(() => ({ ...SETTINGS, defaultClaudeProfileId: 'b' }))
    expect(cmdOf('b')).toBe('envman -e claude:a -- claude')
    expect(cmdOf('default')).toBe('claude')
    registerDefaultProfileOverride(() => undefined)
    expect(cmdOf('b')).toBe('envman -e claude:b -- claude')
  })
  it('a deleted override profile is ignored: stored default; a deleted node profile still gets the notice', () => {
    registerClaudeLaunchSettings(() => SETTINGS)
    registerDefaultProfileOverride(() => 'gone')
    expect(resolveClaudeLaunch().profile.id).toBe('default')
    expect(applyNodeClaudeProfile({ agentId: 'claude', cmd: 'x', claudeProfileId: 'gone' }).notice).toMatch(/no longer exists/)
    expect(applyNodeClaudeProfile({ agentId: 'claude', cmd: 'x', claudeProfileId: 'default' }).msg.cmd).toBe('claude')
  })
  it('no override = stored settings', () => {
    registerClaudeLaunchSettings(() => ({ ...SETTINGS, defaultClaudeProfileId: 'b' }))
    expect(resolveClaudeLaunch().profile.id).toBe('b')
  })
})
