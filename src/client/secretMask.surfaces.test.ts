import { describe, expect, it } from 'vitest'
import { maskLine } from './secretMask.surfaces'
import { searchItems } from './Omnibox.sources'

// test-only fixture: a fake token, not a real credential
const LINE = 'API_KEY=sk_live_abcdefghijklmnop'

describe('maskLine', () => {
  it('hides every value in a .env line but keeps the key and the length', () => {
    const out = maskLine('.env', LINE)
    expect(out).toBe(`API_KEY=${'•'.repeat(LINE.length - 8)}`)
    expect(out).not.toContain('sk_live')
  })
  it('leaves a non-secret line untouched', () => {
    expect(maskLine('src/a.ts', 'const total = items.length')).toBe('const total = items.length')
  })
  it('hides the whole line of a file-wide secret file', () => {
    expect(maskLine('certs/server.pem', 'MIIEvQIBADANBg')).toBe('•'.repeat(14))
  })
})

describe('searchItems with maskSecrets', () => {
  const matches = [
    { file: '.env', line: 1, col: 1, text: LINE },
    { file: 'src/a.ts', line: 4, col: 3, text: 'const total = 1' },
  ]
  it('masks the .env row, keeps the match and the plain row, and keeps the position', () => {
    const rows = searchItems(matches, false, true)
    expect(rows[0].label).not.toContain('sk_live')
    expect(rows[0]).toMatchObject({ description: '.env:1', action: { kind: 'file', rel: '.env', line: 1, col: 1 } })
    expect(rows[1].label).toBe('const total = 1')
  })
  it('shows the raw text when the setting is off', () => {
    expect(searchItems(matches, false, false)[0].label).toBe(LINE)
    expect(searchItems(matches, false)[0].label).toBe(LINE)
  })
})
