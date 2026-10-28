import { describe, it, expect } from 'vitest'
import { AGENTS, assembleCmd, isContextCapable, classifyLink } from './workspace'

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

describe('isContextCapable', () => {
  it('is true for built-in agents', () => {
    expect(isContextCapable('claude')).toBe(true)
    expect(isContextCapable('codex')).toBe(true)
    expect(isContextCapable('gemini')).toBe(true)
  })
  it('is false for custom and undefined', () => {
    expect(isContextCapable('custom')).toBe(false)
    expect(isContextCapable(undefined)).toBe(false)
  })
})

describe('classifyLink', () => {
  it('both ends context-capable -> context', () => {
    expect(classifyLink('claude', 'codex')).toBe('context')
  })
  it('either end not capable -> null', () => {
    expect(classifyLink('claude', undefined)).toBe(null)
    expect(classifyLink('custom', 'claude')).toBe(null)
  })
})
