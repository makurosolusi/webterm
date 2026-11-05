import { describe, expect, it } from 'vitest'
import {
  nodeTargets,
  rankTargets,
  subsequenceMatch,
  targetScore,
  type PaletteTarget,
} from './paletteTargets'

describe('subsequenceMatch', () => {
  it('matches scattered characters in order', () => {
    expect(subsequenceMatch('New Terminal', 'ntr')).toBe(true)
  })
  it('rejects characters out of order', () => {
    expect(subsequenceMatch('New Terminal', 'rtn')).toBe(false)
  })
  it('is case-insensitive', () => {
    expect(subsequenceMatch('New TeRminal', 'NTR')).toBe(true)
  })
  it('empty query matches anything', () => {
    expect(subsequenceMatch('', '')).toBe(true)
    expect(subsequenceMatch('anything', '')).toBe(true)
  })
  it('rejects a character that is absent', () => {
    expect(subsequenceMatch('terminal', 'z')).toBe(false)
  })
})

describe('targetScore', () => {
  const t = (label: string, hint?: string): PaletteTarget => ({ id: label, label, hint })

  it('word-start label substring is the best tier', () => {
    expect(targetScore(t('deploy worker'), 'worker')).toBe(0)
  })
  it('mid-word label substring ranks below a word-start one', () => {
    expect(targetScore(t('coworker'), 'worker')).toBe(1)
  })
  it('hint substring ranks below any label substring', () => {
    expect(targetScore(t('alpha', 'terminal'), 'terminal')).toBe(2)
  })
  it('label subsequence ranks below hint substring', () => {
    expect(targetScore(t('New Terminal'), 'ntr')).toBe(3)
  })
  it('label+hint subsequence is the last matching tier', () => {
    expect(targetScore(t('alpha', 'zeta'), 'apz')).toBe(4)
  })
  it('no match → null', () => {
    expect(targetScore(t('alpha', 'terminal'), 'qqq')).toBeNull()
  })
  it('empty query matches everything at tier 0', () => {
    expect(targetScore(t('alpha'), '   ')).toBe(0)
  })
  it('is case-insensitive on both sides', () => {
    expect(targetScore(t('Deploy Worker'), 'WORKER')).toBe(0)
  })
})

describe('rankTargets', () => {
  // 'a' hanya cocok via hint (tier 2), 'b' substring label di awal kata (tier 0) walau dideklarasi
  // belakangan, 'c' cuma subsequence (tier 3), 'd' tidak cocok.
  const targets: PaletteTarget[] = [
    { id: 'a', label: 'orchestrate', hint: 'agent seo' },
    { id: 'b', label: 'SEO audit', hint: 'terminal' },
    { id: 'c', label: 'something else otherwise', hint: 'terminal' },
    { id: 'd', label: 'nothing relevant', hint: 'terminal' },
  ]

  it('puts the best tier first regardless of declaration order', () => {
    const out = rankTargets(targets, 'seo', 10)
    expect(out.map((t) => t.id)).toEqual(['b', 'a', 'c'])
  })
  it('drops non-matching targets', () => {
    expect(rankTargets(targets, 'seo', 10).map((t) => t.id)).not.toContain('d')
  })
  it('ranks BEFORE applying the cap, so a better row cannot be cut off', () => {
    expect(rankTargets(targets, 'seo', 1).map((t) => t.id)).toEqual(['b'])
  })
  it('keeps declaration order inside one tier', () => {
    const same: PaletteTarget[] = [
      { id: 'x', label: 'build x' },
      { id: 'y', label: 'build y' },
    ]
    expect(rankTargets(same, 'build', 10).map((t) => t.id)).toEqual(['x', 'y'])
  })
  it('empty query returns input order, capped', () => {
    expect(rankTargets(targets, '', 2).map((t) => t.id)).toEqual(['a', 'b'])
  })
  it('an empty target list stays empty', () => {
    expect(rankTargets([], 'seo', 10)).toEqual([])
  })
})

describe('nodeTargets', () => {
  it('prefers the node title as the label', () => {
    expect(nodeTargets([{ id: 'n1', type: 'agent', data: { kind: 'agent', title: 'Deploy', agentId: 'claude' } }]))
      .toEqual([{ id: 'n1', label: 'Deploy', hint: 'agent' }])
  })
  it('falls back to agentId when there is no title', () => {
    expect(nodeTargets([{ id: 'n2', type: 'agent', data: { kind: 'agent', agentId: 'codex' } }])[0].label).toBe('codex')
  })
  it('falls back to kind + short id when the node is unnamed', () => {
    expect(nodeTargets([{ id: 'abcdef123456', type: 'terminal', data: {} }])[0]).toEqual({
      id: 'abcdef123456',
      label: 'terminal abcdef',
      hint: 'terminal',
    })
  })
  it('uses node.type when data.kind is missing', () => {
    expect(nodeTargets([{ id: 'n3', type: 'terminal' }])[0].hint).toBe('terminal')
  })
  it('never produces an empty label, even with no type and no data', () => {
    const [target] = nodeTargets([{ id: 'n4' }])
    expect(target.label).toBe('node n4')
    expect(target.hint).toBe('node')
  })
  it('ignores non-string and blank title/agentId values', () => {
    const [target] = nodeTargets([{ id: 'n5', type: 'agent', data: { title: '   ', agentId: 42 } }])
    expect(target.label).toBe('agent n5')
  })
})
