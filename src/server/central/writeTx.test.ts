import { describe, expect, it } from 'vitest'
import type { Database } from 'bun:sqlite'
import { writeTx } from './writeTx'

function fakeDb(opts: { inTransaction?: boolean; failOn?: string } = {}) {
  const log: string[] = []
  const db = {
    inTransaction: opts.inTransaction,
    exec(sql: string) {
      log.push(sql)
      if (sql === opts.failOn) throw new Error(`boom ${sql}`)
    },
    query: () => ({}),
  }
  return { db: db as unknown as Database, log }
}

describe('writeTx', () => {
  it('begins immediate, commits and returns the result', () => {
    const { db, log } = fakeDb()
    expect(writeTx(db, () => 42)).toBe(42)
    expect(log).toEqual(['BEGIN IMMEDIATE', 'COMMIT'])
  })

  it('hands fn a scoped handle that reports inTransaction and forwards exec', () => {
    const { db, log } = fakeDb()
    writeTx(db, (tx) => {
      expect((tx as unknown as { inTransaction: boolean }).inTransaction).toBe(true)
      tx.exec('INSERT 1')
    })
    expect(log).toEqual(['BEGIN IMMEDIATE', 'INSERT 1', 'COMMIT'])
  })

  it('rolls back and rethrows the original error', () => {
    const { db, log } = fakeDb()
    const err = new Error('nope')
    expect(() => writeTx(db, () => { throw err })).toThrow(err)
    expect(log).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK'])
  })

  it('rethrows the original error even when ROLLBACK itself fails', () => {
    const { db } = fakeDb({ failOn: 'ROLLBACK' })
    expect(() => writeTx(db, () => { throw new Error('original') })).toThrow('original')
  })

  it('joins an open transaction without a second BEGIN or COMMIT', () => {
    const { db, log } = fakeDb({ inTransaction: true })
    expect(writeTx(db, (tx) => (tx === db ? 'same' : 'scoped'))).toBe('same')
    expect(log).toEqual([])
  })
})
