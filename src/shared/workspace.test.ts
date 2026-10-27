import { describe, it, expect } from 'vitest'
import { AGENTS, assembleCmd } from './workspace'

describe('assembleCmd', () => {
  it('returns the bare command without a profile', () => {
    expect(assembleCmd('claude')).toBe('claude')
  })

  it('wraps the command with envman when a profile is given', () => {
    expect(assembleCmd('claude', 'malik-opus')).toBe('envman -e malik-opus -- claude')
    expect(assembleCmd('codex', 'work')).toBe('envman -e work -- codex')
  })
})

describe('AGENTS', () => {
  it('every agent has a non-empty label, hex color, and launchCmd', () => {
    for (const cfg of Object.values(AGENTS)) {
      expect(cfg.label.length).toBeGreaterThan(0)
      expect(cfg.color).toMatch(/^#[0-9a-fA-F]{3,8}$/)
      expect(cfg.launchCmd.length).toBeGreaterThan(0)
    }
  })
})
