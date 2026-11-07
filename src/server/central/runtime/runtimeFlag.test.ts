import { describe, expect, it } from 'vitest'
import {
  CENTRAL_RUNTIME_FLAG,
  DEFAULT_RUNTIME_KIND,
  centralRuntimeEnabled,
  centralRuntimeKind,
  parseRuntimeKind,
} from './runtimeFlag'

describe('WEBTERM_CENTRAL_RUNTIME parsing', () => {
  it('defaults to off for unset, empty, and unsupported values', () => {
    expect(DEFAULT_RUNTIME_KIND).toBe('off')
    expect(parseRuntimeKind(undefined)).toBe('off')
    expect(parseRuntimeKind(null)).toBe('off')
    expect(parseRuntimeKind('')).toBe('off')
    expect(parseRuntimeKind('   ')).toBe('off')
    expect(parseRuntimeKind('on')).toBe('off')
    expect(parseRuntimeKind('gpt')).toBe('off')
    expect(parseRuntimeKind('sk-abcdefghijklmnopqrstuvwx')).toBe('off')
  })

  it('accepts supported adapters case-insensitively and trims whitespace', () => {
    expect(parseRuntimeKind('off')).toBe('off')
    expect(parseRuntimeKind('MOCK')).toBe('mock')
    expect(parseRuntimeKind('  Mock  ')).toBe('mock')
    expect(parseRuntimeKind('Claude')).toBe('claude')
    expect(parseRuntimeKind(' CODEX ')).toBe('off') // belum ada adapter codex
  })

  it('reads the process flag by default but accepts an explicit value', () => {
    expect(CENTRAL_RUNTIME_FLAG).toBe('WEBTERM_CENTRAL_RUNTIME')
    expect(centralRuntimeKind('mock')).toBe('mock')
    expect(centralRuntimeKind('nonsense')).toBe('off')
  })

  it('tak diset = deteksi otomatis; string kosong/tak dikenal tetap fail-closed', () => {
    expect(centralRuntimeKind(undefined, (bin) => bin === 'claude')).toBe('claude')
    expect(centralRuntimeKind(undefined, (bin) => bin === 'opencode')).toBe('off')
    expect(centralRuntimeKind(undefined, () => false)).toBe('off')
    expect(centralRuntimeKind('', () => true)).toBe('off')
    expect(centralRuntimeEnabled(undefined, () => false)).toBe(false)
  })

  it('stored opencode resolves to claude: a retired engine means automatic, never a silent off', () => {
    for (const raw of ['opencode', ' OpenCode ', 'codex']) {
      expect(centralRuntimeKind(raw, (bin) => bin === 'claude'), raw).toBe('claude')
      expect(centralRuntimeKind(raw, () => false), raw).toBe('off')
    }
    expect(parseRuntimeKind('opencode')).toBe('off') // the pure parser stays fail-closed; only the resolver maps it
  })

  it('enables only explicitly selected adapters', () => {
    expect(centralRuntimeEnabled('off')).toBe(false)
    expect(centralRuntimeEnabled('OFF')).toBe(false)
    expect(centralRuntimeEnabled('garbage')).toBe(false)
    expect(centralRuntimeEnabled('mock')).toBe(true)
    expect(centralRuntimeEnabled(' Claude ')).toBe(true)
  })

  it('never returns the raw input value', () => {
    const secret = 'token=sk-abcdefghijklmnopqrstuvwx'
    expect(parseRuntimeKind(secret)).toBe('off')
    expect(centralRuntimeKind(secret)).toBe('off')
  })
})
