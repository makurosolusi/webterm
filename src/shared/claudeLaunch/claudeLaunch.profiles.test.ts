import { describe, expect, it } from 'vitest'
import { mergeSettings } from '../settings'
import { normalizeClaudeProfiles, resolveProfileLaunch } from './claudeLaunch.profiles'

describe('agentLaunchCommands.claude migration seed', () => {
  it('seeds a "Custom" profile and makes it the default', () => {
    const s = mergeSettings({ agentLaunchCommands: { claude: 'envman -e a:b -- claude' } })
    expect(s.claudeLaunchProfiles).toEqual([{ id: 'custom', name: 'Custom', command: 'envman -e a:b -- claude' }])
    expect(s.defaultClaudeProfileId).toBe('custom')
    expect(s.agentLaunchCommands.claude).toBe('envman -e a:b -- claude') // still readable (back-compat)
  })

  it('runs once: a stored profile list (even empty) is never reseeded', () => {
    const first = mergeSettings({ agentLaunchCommands: { claude: 'x' } })
    const reloaded = mergeSettings(JSON.parse(JSON.stringify(first)))
    expect(reloaded.claudeLaunchProfiles).toHaveLength(1)
    expect(mergeSettings({ agentLaunchCommands: { claude: 'x' }, claudeLaunchProfiles: [] }).claudeLaunchProfiles).toEqual([])
  })

  it('keeps an explicit default, and seeds nothing without a legacy command', () => {
    expect(mergeSettings({ agentLaunchCommands: { claude: 'x' }, defaultClaudeProfileId: 'default' }).defaultClaudeProfileId).toBe('default')
    const plain = mergeSettings({})
    expect(plain.claudeLaunchProfiles).toEqual([])
    expect(plain.defaultClaudeProfileId).toBe('default')
  })
})

describe('normalizeClaudeProfiles', () => {
  it('drops malformed, duplicate and reserved-id entries', () => {
    expect(normalizeClaudeProfiles([
      { id: 'a', name: 'A', command: 'claude' }, { id: 'a', name: 'dup', command: '' }, { id: 'default', name: 'D', command: 'x' },
      { id: '', name: 'n', command: '' }, { id: 'b', name: 3, command: '' }, null, 'x', { id: 'c', name: ' ', command: 'claude' },
    ])).toEqual([{ id: 'a', name: 'A', command: 'claude' }, { id: 'c', name: 'c', command: 'claude' }])
  })
})

describe('resolveProfileLaunch', () => {
  const s = { claudeLaunchProfiles: [{ id: 'm', name: 'Malik', command: 'envman -e claude:malik-opus --' }], defaultClaudeProfileId: 'm', centralClaudeProfileId: '' }
  it('absent id = the default profile; argv is normalised', () => {
    const r = resolveProfileLaunch(s)
    expect(r.profile.name).toBe('Malik')
    expect(r.argv).toEqual(['envman', '-e', 'claude:malik-opus', '--', 'claude'])
    expect(r.missingId).toBeUndefined()
  })
  it('a deleted profile falls back to Default and says which id was missing', () => {
    const r = resolveProfileLaunch(s, 'gone')
    expect(r.profile.id).toBe('default')
    expect(r.argv).toEqual(['claude'])
    expect(r.missingId).toBe('gone')
  })
})
