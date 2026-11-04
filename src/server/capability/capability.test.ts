import { describe, expect, it } from 'vitest'
import { capabilityProblems, createCapabilityIndex, defineCapability, type CapabilitySpec } from './capability.define'
import { callFingerprint, createMemoryReceiptLog, runOnce, type Receipt } from './capability.receipt'
import { checkSchema, obj, S } from './capability.schema'

const cap = (name: string, extra: Partial<CapabilitySpec> = {}): CapabilitySpec => ({
  name, summary: `does ${name}`, tier: 'R0', scope: 'global', input: obj({}), output: obj({}), projections: ['central'], ...extra,
})
const ok = (detail = 'ok'): Receipt => ({ outcome: 'ok', detail, next: null, evidence: {}, operationId: null })

describe('checkSchema', () => {
  const schema = obj({ id: S.str(5, { pattern: '^[a-z]+$' }), n: S.int(1, 3), mode: S.oneOf('a', 'b'), tags: S.arr(S.str(), 2), x: { type: 'number' } }, ['id'])
  it('accepts a conforming value and reports the first violation by path', () => {
    expect(checkSchema(schema, { id: 'abc', n: 2, mode: 'a', tags: ['t'], x: 1.5 })).toBeNull()
    expect(checkSchema(schema, {})).toBe('$.id: required')
    expect(checkSchema(schema, { id: 'ABC' })).toBe('$.id: pattern')
    expect(checkSchema(schema, { id: 'abcdef' })).toBe('$.id: maxLength')
    expect(checkSchema(schema, { id: 'a', n: 1.5 })).toBe('$.n: type integer')
    expect(checkSchema(schema, { id: 'a', n: 4 })).toBe('$.n: maximum')
    expect(checkSchema(schema, { id: 'a', mode: 'c' })).toBe('$.mode: enum')
    expect(checkSchema(schema, { id: 'a', tags: ['a', 'b', 'c'] })).toBe('$.tags: maxItems')
    expect(checkSchema(schema, { id: 'a', tags: [1] })).toBe('$.tags[0]: type string')
    expect(checkSchema(schema, { id: 'a', x: 2 })).toBeNull() // integer satisfies number
    expect(checkSchema(schema, [])).toBe('$: type object')
  })
  it('anyOf passes when one branch does', () => {
    const either = { anyOf: [S.str(), S.int()] }
    expect(checkSchema(either, 'x')).toBeNull()
    expect(checkSchema(either, 1)).toBeNull()
    expect(checkSchema(either, true)).toBe('$: anyOf')
  })
})

describe('defineCapability', () => {
  it('returns a well-formed spec and rejects missing schema, tier, summary or route', () => {
    expect(defineCapability(cap('a.b')).name).toBe('a.b')
    expect(() => defineCapability(cap('Bad Name'))).toThrow(/name/)
    expect(() => defineCapability(cap('a.b', { summary: 'x'.repeat(121) }))).toThrow(/summary/)
    expect(() => defineCapability(cap('a.b', { tier: 'R9' as never }))).toThrow(/tier/)
    expect(capabilityProblems(cap('a.b', { input: S.str() }))).toEqual(['input'])
    expect(capabilityProblems(cap('a.b', { output: undefined as never }))).toEqual(['output'])
    expect(capabilityProblems(cap('a.b', { projections: ['control-http'] }))).toEqual(['route'])
  })
})

describe('createCapabilityIndex', () => {
  const index = createCapabilityIndex([
    cap('node.spawn', { summary: 'Start an agent session', tier: 'R2' }),
    cap('kb.search', { summary: 'Search project docs' }),
    cap('memory.search', { summary: 'Search remembered facts' }),
    cap('kb.search', { projections: ['control-http'], route: { method: 'GET', path: '/x' } }),
  ])
  it('sorts by name and merges the same name across surfaces', () => {
    expect(index.list().map((c) => c.name)).toEqual(['kb.search', 'memory.search', 'node.spawn'])
    expect(index.get('kb.search')?.projections).toEqual(['central', 'control-http'])
  })
  it('refuses the same name with a different tier', () => {
    expect(() => createCapabilityIndex([cap('a'), cap('a', { tier: 'R1' })])).toThrow(/different tier/)
  })
  it('search ranks name hits over summary hits, honours limit and projection', () => {
    expect(index.search('search').map((h) => h.name)).toEqual(['kb.search', 'memory.search'])
    expect(index.search('docs')[0]?.name).toBe('kb.search')
    expect(index.search('agent session')[0]).toEqual({ name: 'node.spawn', summary: 'Start an agent session', tier: 'R2', projections: ['central'] })
    expect(index.search('', { limit: 2 })).toHaveLength(2)
    expect(index.search('search', { projection: 'control-http' }).map((h) => h.name)).toEqual(['kb.search'])
    expect(index.search('nothing-matches')).toEqual([])
  })
})

describe('runOnce (idempotent replay)', () => {
  it('runs once per operationId and replays the stored receipt', async () => {
    const log = createMemoryReceiptLog()
    let runs = 0
    const run = async () => { runs++; return ok() }
    const fp = callFingerprint('x', { a: 1, b: 2 })
    const first = await runOnce(log, 'op-1', fp, run)
    const again = await runOnce(log, 'op-1', callFingerprint('x', { b: 2, a: 1 }), run)
    expect(runs).toBe(1)
    expect(first).toMatchObject({ outcome: 'ok', operationId: 'op-1' })
    expect(again).toMatchObject({ outcome: 'ok', operationId: 'op-1', replayed: true })
  })
  it('rejects a reused id with different args, and malformed ids', async () => {
    const log = createMemoryReceiptLog()
    await runOnce(log, 'op-1', callFingerprint('x', { a: 1 }), async () => ok())
    expect(await runOnce(log, 'op-1', callFingerprint('x', { a: 2 }), async () => ok())).toMatchObject({ outcome: 'error', detail: 'operation_conflict' })
    expect(await runOnce(log, 'bad id!', 'f', async () => ok())).toMatchObject({ detail: 'invalid_operation_id' })
  })
  it('does not store failures, so a retry under the same id runs again', async () => {
    const log = createMemoryReceiptLog()
    let runs = 0
    const fail = async (): Promise<Receipt> => { runs++; return { ...ok(), outcome: 'denied', detail: 'tier_denied' } }
    await runOnce(log, 'op-1', 'f', fail)
    await runOnce(log, 'op-1', 'f', fail)
    expect(runs).toBe(2)
  })
  it('concurrent repeats join the call in flight', async () => {
    const log = createMemoryReceiptLog()
    let runs = 0
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const run = async () => { runs++; await gate; return ok() }
    const a = runOnce(log, 'op-1', 'f', run)
    const b = runOnce(log, 'op-1', 'f', run)
    release()
    expect((await Promise.all([a, b])).map((r) => r.replayed ?? false)).toEqual([false, true])
    expect(runs).toBe(1)
  })
  it('without an id always runs; the log evicts its oldest entry past max', async () => {
    const log = createMemoryReceiptLog(2)
    let runs = 0
    const run = async () => { runs++; return ok() }
    await runOnce(log, undefined, 'f', run)
    await runOnce(log, undefined, 'f', run)
    expect(runs).toBe(2)
    for (const id of ['a', 'b', 'c']) await runOnce(log, id, 'f', run)
    expect(log.get('a')).toBeUndefined()
    expect(log.get('c')).toBeDefined()
  })
})
