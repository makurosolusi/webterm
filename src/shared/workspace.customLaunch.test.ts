import { describe, expect, it } from 'vitest'
import { assembleCmd, customLaunchCmd } from './workspace'
import type { CustomAgent } from './settings'

const agent = (over: Partial<CustomAgent> = {}): CustomAgent => ({ id: 'custom:a1', label: 'A', launchCmd: '', ...over })

describe('customLaunchCmd', () => {
  it('memakai launchCmd sendiri (di-trim) bila terisi', () => {
    expect(customLaunchCmd(agent({ launchCmd: '  my-proxy --tui ', baseAgent: 'claude' }), {})).toBe('my-proxy --tui')
  })

  it('launchCmd kosong + baseAgent => perintah base builtin', () => {
    expect(customLaunchCmd(agent({ baseAgent: 'claude' }), {})).toBe(assembleCmd('claude'))
    expect(assembleCmd('claude')).not.toBe('')
  })

  it('launchCmd kosong + baseAgent => override pengguna untuk base dihormati', () => {
    expect(customLaunchCmd(agent({ baseAgent: 'claude' }), { claude: 'claude-work' })).toBe('claude-work')
  })

  it('tanpa launchCmd dan tanpa baseAgent => string kosong', () => {
    expect(customLaunchCmd(agent(), { claude: 'claude-work' })).toBe('')
    expect(customLaunchCmd(agent({ launchCmd: '   ' }), {})).toBe('')
  })
})
