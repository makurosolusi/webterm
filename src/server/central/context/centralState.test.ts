import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openFixture, seedPortfolio, type Fixture } from '../centralTestFixture.testutil'
import { CentralStateError, GLOBAL_STATE, STATE_EVENT_KIND, STATE_MAX_BYTES, STATE_MAX_LINES, projectState, readState, writeState } from './centralState'

let f: Fixture
beforeEach(() => { f = openFixture(); seedPortfolio(f.db) })
afterEach(() => f.close())

const write = (body: string, expectedVersion = 0, scope = GLOBAL_STATE) => writeState(f.db, { scope, body, expectedVersion, actor: 'central', now: 7 })
const codeOf = (fn: () => unknown): string => {
  try { fn() } catch (err) { if (err instanceof CentralStateError) return err.code; throw err }
  return 'none'
}
const events = () => f.db.query(`SELECT actor, project_id, payload_json FROM event WHERE kind = '${STATE_EVENT_KIND}'`).all() as Array<{ actor: string; project_id: string | null; payload_json: string }>

describe('centralState', () => {
  it('reads null until written, then versions every write', () => {
    expect(readState(f.db, GLOBAL_STATE)).toBeNull()
    expect(write('one')).toEqual({ scope: 'global', body: 'one', version: 1, updatedAt: 7, updatedBy: 'central' })
    expect(write('two', 1).version).toBe(2)
    expect(readState(f.db, GLOBAL_STATE)?.body).toBe('two')
  })

  it('refuses a stale version and leaves the document and the audit alone', () => {
    write('one')
    expect(codeOf(() => write('lost', 0))).toBe('version_conflict')
    expect(codeOf(() => write('lost', 5))).toBe('version_conflict')
    expect(readState(f.db, GLOBAL_STATE)?.body).toBe('one')
    expect(events()).toHaveLength(1)
  })

  it('caps lines and bytes and names the limit', () => {
    expect(write(Array(STATE_MAX_LINES).fill('x').join('\n')).version).toBe(1)
    expect(() => write(Array(STATE_MAX_LINES + 1).fill('x').join('\n'), 1)).toThrow(/state_too_large \(limit 200 lines, got 201\)/)
    expect(() => write('x'.repeat(STATE_MAX_BYTES + 1), 1)).toThrow(/state_too_large \(limit 25600 bytes/)
    expect(codeOf(() => write('é'.repeat(STATE_MAX_BYTES / 2 + 1), 1))).toBe('state_too_large')
  })

  it('redacts secrets before storing', () => {
    const secret = 'sk-test0123456789abcdefghij' // test-only
    expect(write(`key is ${secret}`).body).toBe('key is [redacted]')
    expect(JSON.stringify(f.db.query('SELECT body FROM central_state').all())).not.toContain(secret)
  })

  it('writes one audit event with actor and version and no body', () => {
    write('private plan', 0, projectState('p1'))
    const [row] = events()
    expect(events()).toHaveLength(1)
    expect(row).toMatchObject({ actor: 'central', project_id: 'p1' })
    expect(JSON.parse(row!.payload_json)).toEqual({ scope: 'project:p1', version: 1 })
    expect(row!.payload_json).not.toContain('private plan')
  })

  it('refuses a project that does not exist', () => {
    expect(codeOf(() => write('x', 0, projectState('ghost')))).toBe('project_not_found')
  })
})
