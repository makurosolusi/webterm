import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CAPABILITY_PRESETS, SCOPE_PRESETS, SUBJECTS, secretRule, whatText, whereText, whoText } from './policyPresets'

const read = (f: string): string => readFileSync(join(dirname(fileURLToPath(import.meta.url)), f), 'utf8')

describe('policy presets (shared by rules and the simulator)', () => {
  it('both panels import the one list instead of keeping their own', () => {
    for (const f of ['PolicyRules.tsx', 'PolicySimulator.tsx']) {
      expect(read(f)).toContain("from './policyPresets'")
      expect(read(f)).not.toMatch(/const (CAPABILITY_PRESETS|SCOPE_PRESETS|SUBJECTS) =/)
    }
  })

  it('every preset has a plain label without pattern characters', () => {
    for (const p of [...SUBJECTS, ...CAPABILITY_PRESETS, ...SCOPE_PRESETS]) expect(p.label ?? '').toMatch(/^[A-Z][^*:]*$/)
  })

  it('reads patterns in plain words', () => {
    expect(whoText('node:*')).toBe('Any agent')
    expect(whoText('node:a1')).toBe('Agent a1')
    expect(whoText('telegram:42')).toBe('Telegram chat 42')
    expect(whatText('claude.tool:Bash')).toBe('Run commands')
    expect(whatText('custom.verb')).toBe('custom.verb')
    expect(whereText('*')).toBe('anywhere')
    expect(whereText('git status*')).toBe('starting with git status')
    expect(whereText('secret:NPM_TOKEN:*')).toBe('NPM_TOKEN, any command')
    expect(whereText('a*b')).toBe('a*b')
  })

  it('a secret rule matches the broker resource secret:<NAME>:<command>', () => {
    expect(secretRule('NPM_TOKEN')).toEqual({ capability: 'secret.run', scope: 'secret:NPM_TOKEN:*' })
  })
})
