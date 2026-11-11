import { describe, expect, it } from 'vitest'
import { NO_RULE_SOURCE, citesKnownRule, isSafeRelative, quoteNear, verifyAnalysis } from './healthAnalyzeVerify'

const FILES: Record<string, string> = { // test-only repo
  'src/big.ts': ['import a from "a"', '', 'export function doEverything(input: unknown) {', '  return input', '}', '// end'].join('\n'),
  'src/auth.ts': 'export const check = (token: string) => token === "x"\n',
  '.env': 'API_KEY=abc\n',
}
const RULES = ['# Rules\n## 8. File Health\nOne responsibility per file.\n']
const input = { cwd: '/repo', tracked: new Set(Object.keys(FILES)), ruleTexts: RULES, read: async (abs: string) => FILES[abs.slice('/repo/'.length)] ?? null }
const claim = (over: Record<string, unknown> = {}) => ({
  title: 'God function', file: 'src/big.ts', line: 3, quote: 'export function doEverything(input: unknown)', evidence: 'does too much',
  suggestion: 'split it', severity: 'medium', category: 'structure', source: 'none', ...over,
})

describe('verifyAnalysis', () => {
  it('keeps a claim whose quote is at its line and shapes the draft', async () => {
    const r = await verifyAnalysis({ findings: [claim()] }, input)
    expect(r.dropped).toEqual({})
    expect(r.drafts).toHaveLength(1)
    expect(r.drafts[0]).toMatchObject({ rule: 'analysis', confidence: 'medium', severity: 'medium', file: 'src/big.ts', line: 3, source: NO_RULE_SOURCE })
    expect(r.drafts[0]!.evidence).toBe('"export function doEverything(input: unknown)" — does too much')
    expect(r.drafts[0]!.fingerprint).toMatch(/^[0-9a-f]{40}$/)
  })

  it('drops fabricated files, wrong lines, missing or short quotes, traversal, secrets and duplicates', async () => {
    const r = await verifyAnalysis({
      findings: [
        claim({ file: 'src/ghost.ts' }), claim({ line: 99 }), claim({ quote: 'function neverWritten()' }), claim({ quote: 'return' }),
        claim({ file: '../etc/passwd' }), claim({ file: '/etc/passwd' }), claim({ file: '.env', line: 1, quote: 'API_KEY=abc' }),
        claim(), claim(), claim({ severity: 'urgent' }), 'junk',
      ],
    }, input)
    expect(r.drafts).toHaveLength(1)
    expect(r.dropped).toEqual({ untracked_file: 1, bad_line: 1, quote_not_found: 1, short_quote: 1, bad_path: 2, secret_file: 1, duplicate: 1, malformed: 2 })
  })

  it('finds a quote within ±3 lines, whitespace-normalised, and no further', async () => {
    const lines = FILES['src/big.ts']!.split('\n')
    expect(quoteNear(lines, 6, 'export   function doEverything')).toBe(true)
    expect(quoteNear(lines, 1, 'return input')).toBe(true) // line 4 is within 1+3
    expect(quoteNear(['a', 'b', 'c', 'd', 'e', 'target line here'], 1, 'target line here')).toBe(false)
  })

  it('caps severity at medium unless the claim is about risk or tests; confidence is never high', async () => {
    const r = await verifyAnalysis({ findings: [claim({ severity: 'high' }), claim({ severity: 'high', category: 'risk', file: 'src/auth.ts', line: 1, quote: 'token === "x"' })] }, input)
    expect(r.drafts.map((d) => [d.severity, d.confidence])).toEqual([['medium', 'medium'], ['high', 'medium']])
  })

  it('names a source only when the cited rule exists in the rule texts', async () => {
    expect(citesKnownRule('Rule 8: one responsibility', RULES)).toBe(true)
    expect(citesKnownRule('Rule 42', RULES)).toBe(false)
    expect(citesKnownRule('CLAUDE.md: "One responsibility per file"', RULES)).toBe(true)
    expect(citesKnownRule('Clean Code chapter 3', RULES)).toBe(false)
    expect(citesKnownRule('none', RULES)).toBe(false)
    const r = await verifyAnalysis({ findings: [claim({ source: 'Rule 8' })] }, input)
    expect(r.drafts[0]!.source).toBe('CLAUDE.md: Rule 8')
  })

  it('treats a non-object answer as no findings', async () => {
    expect(await verifyAnalysis(null, input)).toEqual({ drafts: [], dropped: {}, checked: 0 })
    expect(isSafeRelative('src/./x.ts')).toBe(false)
    expect(isSafeRelative('C:/x')).toBe(false)
  })
})
