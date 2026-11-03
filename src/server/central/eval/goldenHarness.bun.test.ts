// Bun-only (bun:sqlite). Guards the harness primitives the golden tests lean on.
import { createServer } from 'node:net'
import { expect, test } from 'bun:test'
import { execWrite } from '../../ledger/ledgerCore'
import { createHarness, freePort, GOLDEN_PROJECT } from './goldenHarness'

test('freePort returns a port that can actually be bound', async () => {
  const port = await freePort()
  expect(port > 0).toBe(true)
  await new Promise<void>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => server.close(() => resolve()))
  })
})

test('dbContains finds a value in any table and misses an absent one', async () => {
  const h = await createHarness({ turns: [] })
  try {
    expect(h.dbContains('needle-xyz')).toBe(false)
    execWrite(h.db, `UPDATE project SET name = ? WHERE id = ?`, 'has needle-xyz inside', GOLDEN_PROJECT)
    expect(h.dbContains('needle-xyz')).toBe(true)
  } finally {
    h.cleanup()
  }
})

test('restart reopens the same file: data survives, clock stays virtual', async () => {
  const h = await createHarness({ turns: [] })
  try {
    const before = h.clock.now()
    const result = h.restart([])
    expect(h.count(`SELECT COUNT(*) AS c FROM project WHERE id = ?`, GOLDEN_PROJECT)).toBe(1)
    expect(h.clock.now()).toBe(before)
    expect(typeof result).toBe('object')
  } finally {
    h.cleanup()
  }
})
