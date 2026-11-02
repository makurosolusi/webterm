import { describe, expect, it } from 'vitest'
import { PlanError, normalizeItems, validateScope, validateTitle } from './plan'

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(PlanError)
    expect((err as PlanError).code).toBe(code)
    return
  }
  throw new Error(`expected PlanError ${code}, nothing thrown`)
}

describe('validateScope', () => {
  it('normalizes ./, trailing slashes, and duplicate entries', () => {
    expect(validateScope(['./src/api.ts', 'src/api.ts', 'src/shared/'])).toEqual([
      'src/api.ts',
      'src/shared',
    ])
  })

  it('accepts nested relative paths and globs', () => {
    expect(validateScope(['src/server/**/*.ts', 'docs/03-RENCANA.md'])).toEqual([
      'src/server/**/*.ts',
      'docs/03-RENCANA.md',
    ])
  })

  it('rejects absolute paths, traversal, and empty entries', () => {
    expectCode(() => validateScope(['/etc/passwd']), 'invalid_scope')
    expectCode(() => validateScope(['C:/Windows']), 'invalid_scope')
    expectCode(() => validateScope(['src/../../etc/passwd']), 'invalid_scope')
    expectCode(() => validateScope(['src/..']), 'invalid_scope')
    expectCode(() => validateScope(['']), 'invalid_scope')
    expectCode(() => validateScope(['./']), 'invalid_scope')
  })

  it('rejects non-arrays and empty scopes', () => {
    expectCode(() => validateScope('src/a.ts'), 'invalid_scope')
    expectCode(() => validateScope([]), 'invalid_scope')
    expectCode(() => validateScope([1 as never]), 'invalid_scope')
  })
})

describe('validateTitle', () => {
  it('trims and rejects blank or oversized titles', () => {
    expect(validateTitle('  build api  ')).toBe('build api')
    expectCode(() => validateTitle('   '), 'invalid_item')
    expectCode(() => validateTitle('x'.repeat(501)), 'invalid_item')
    expectCode(() => validateTitle(42), 'invalid_item')
  })
})

describe('normalizeItems', () => {
  it('validates every item and keeps optional taskId', () => {
    const items = normalizeItems([
      { title: 'a', scope: ['src/a.ts'], taskId: 't1' },
      { title: 'b', scope: ['src/b.ts'] },
    ])
    expect(items.length).toBe(2)
    expect(items[0]).toEqual({ title: 'a', scope: ['src/a.ts'], taskId: 't1' })
    expect(items[1]?.taskId).toBe(undefined)
  })

  it('rejects empty plans and blank task ids', () => {
    expectCode(() => normalizeItems([]), 'invalid_item')
    expectCode(() => normalizeItems([{ title: 'a', scope: ['a'], taskId: '  ' }]), 'invalid_item')
    expectCode(() => normalizeItems([{ title: 'a', scope: ['a'], taskId: 7 }]), 'invalid_item')
  })

  it('caps the plan size', () => {
    const many = Array.from({ length: 51 }, (_, index) => ({
      title: `item ${index}`,
      scope: [`src/${index}.ts`],
    }))
    expectCode(() => normalizeItems(many), 'too_many_items')
  })
})
