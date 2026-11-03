import { describe, expect, it } from 'vitest'
import { fuzzyFilter, fuzzyScore } from './fuzzy'

describe('fuzzyScore', () => {
  it('returns null when the query is not a subsequence', () => {
    expect(fuzzyScore('xyz', 'src/app.ts')).toBeNull()
    expect(fuzzyScore('tsa', 'src/app.ts')).toBeNull()
  })
  it('is case-insensitive', () => {
    expect(fuzzyScore('APP', 'src/app.ts')).toBe(fuzzyScore('app', 'SRC/App.ts'))
    expect(fuzzyScore('app', 'src/app.ts')).not.toBeNull()
  })
  it('empty query matches everything with score 0', () => {
    expect(fuzzyScore('', 'any/thing')).toBe(0)
  })
})

describe('fuzzyFilter', () => {
  const files = ['docs/notes/appendix.md', 'src/a/p/xp.ts', 'src/app.ts', 'src/utils/helper-app.ts', 'README.md']
  it('ranks file-name matches and consecutive runs first', () => {
    const r = fuzzyFilter('app', files, 10)
    expect(r[0]).toBe('src/app.ts')
    expect(r).not.toContain('README.md')
    expect(r.indexOf('src/app.ts')).toBeLessThan(r.indexOf('src/a/p/xp.ts'))
  })
  it('rewards segment starts', () => {
    expect(fuzzyFilter('ha', ['src/xhax.ts', 'src/helper-app.ts'], 5)[0]).toBe('src/helper-app.ts')
  })
  it('keeps input order on ties (stable) and for an empty query', () => {
    expect(fuzzyFilter('', files, 3)).toEqual(files.slice(0, 3))
    expect(fuzzyFilter('a.ts', ['b/a.ts', 'c/a.ts'], 5)).toEqual(['b/a.ts', 'c/a.ts'])
  })
  it('returns [] when nothing matches and honours the limit', () => {
    expect(fuzzyFilter('zzz', files, 5)).toEqual([])
    expect(fuzzyFilter('s', files, 2)).toHaveLength(2)
  })
})
