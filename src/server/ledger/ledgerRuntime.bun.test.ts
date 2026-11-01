import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'bun:test'
import { ledgerMode, startLedgerReaper, startLedgerRuntime } from './ledgerRuntime'

const root = mkdtempSync(join(tmpdir(), 'webterm-ledger-runtime-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

test('flag parsing: only shadow/on enable the ledger', () => {
  expect(ledgerMode(undefined)).toBe('off')
  expect(ledgerMode('')).toBe('off')
  expect(ledgerMode('garbage')).toBe('off')
  expect(ledgerMode(' OFF ')).toBe('off')
  expect(ledgerMode('shadow')).toBe('shadow')
  expect(ledgerMode('ON')).toBe('on')
})

test('off starts nothing', () => {
  expect(startLedgerRuntime({ mode: 'off', path: join(root, 'off.db') })).toBe(null)
})

test('on opens, migrates, and survives reopen', () => {
  const path = join(root, 'on.db')
  const first = startLedgerRuntime({ mode: 'on', path, now: 1_000 })
  expect(first).not.toBe(null)
  first!.ledger.project.createProject({
    id: 'p1',
    workspaceId: 'w1',
    name: 'p',
    path: '/tmp/p',
  })
  first!.close()

  const second = startLedgerRuntime({ mode: 'on', path, now: 2_000 })
  expect(second!.ledger.project.getProject('p1')?.name).toBe('p')
  second!.close()
})

test('shadow swallows a broken ledger instead of blocking boot', () => {
  // Parent is a regular file, so neither mkdir nor SQLite can open a database below it.
  const bad = join(root, 'not-a-dir')
  writeFileSync(bad, 'occupied')
  const runtime = startLedgerRuntime({ mode: 'shadow', path: join(bad, 'x.db') })
  expect(runtime).toBe(null)
})

test('reaper ticks sweep expired leases and survive a throwing tick', async () => {
  let swept = 0
  let errors = 0
  const fake = {
    task: {
      sweepExpiredLeases: () => {
        swept += 1
        if (swept === 2) throw new Error('boom')
        return []
      },
    },
  }
  const stop = startLedgerReaper(fake, 5, () => {
    errors += 1
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  stop()
  expect(swept >= 2).toBe(true)
  expect(errors).toBe(1)
})

test('L2: ledger dir is 0700 and db/wal/shm files are 0600', () => {
  const dir = join(root, 'private-ledger')
  const path = join(dir, 'ledger.db')
  const runtime = startLedgerRuntime({ mode: 'on', path, now: 1_000 })
  expect(runtime).not.toBe(null)
  // Touch the DB so SQLite materialises the WAL/SHM sidecars.
  runtime!.ledger.project.createProject({
    id: 'p1',
    workspaceId: 'w1',
    name: 'p',
    path: '/tmp/p',
  })
  expect(statSync(dir).mode & 0o777).toBe(0o700)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${path}${suffix}`)) expect(statSync(`${path}${suffix}`).mode & 0o777).toBe(0o600)
  }
  runtime!.close()

  // An existing, loosely-permissioned database is tightened on the next open.
  chmodSync(path, 0o644)
  chmodSync(dir, 0o755)
  const reopened = startLedgerRuntime({ mode: 'on', path, now: 2_000 })
  expect(statSync(dir).mode & 0o777).toBe(0o700)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  reopened!.close()
})
