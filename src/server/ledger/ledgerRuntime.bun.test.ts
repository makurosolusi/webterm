import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'bun:test'
import { activeLedgerRuntime, ledgerMode, startLedgerReaper, startLedgerRuntime } from './ledgerRuntime'

// Batas atas file ledger kosong (R-E1): skema + indeks saja, tanpa baris.
const MAX_EMPTY_LEDGER_BYTES = 1024 * 1024

const root = mkdtempSync(join(tmpdir(), 'webterm-ledger-runtime-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

test('ledger selalu hidup: default on, shadow hanya lewat WEBTERM_LEDGER_SHADOW, WEBTERM_LEDGER lama diabaikan', () => {
  // Bun auto-loads .env, so ambient values must not leak into this test.
  const prev = { shadow: process.env.WEBTERM_LEDGER_SHADOW, legacy: process.env.WEBTERM_LEDGER }
  try {
    delete process.env.WEBTERM_LEDGER_SHADOW
    process.env.WEBTERM_LEDGER = 'off'
    expect(ledgerMode(undefined)).toBe('on')
    expect(ledgerMode('')).toBe('on')
    expect(ledgerMode('garbage')).toBe('on')
    expect(ledgerMode('off')).toBe('on')
    expect(ledgerMode('1')).toBe('shadow')
    expect(ledgerMode(' ON ')).toBe('shadow')
    expect(ledgerMode()).toBe('on') // override lama 'off' tidak dihormati

    process.env.WEBTERM_LEDGER_SHADOW = '1'
    expect(ledgerMode()).toBe('shadow')
  } finally {
    if (prev.shadow === undefined) delete process.env.WEBTERM_LEDGER_SHADOW
    else process.env.WEBTERM_LEDGER_SHADOW = prev.shadow
    if (prev.legacy === undefined) delete process.env.WEBTERM_LEDGER
    else process.env.WEBTERM_LEDGER = prev.legacy
  }
})

test('store kosong: ledger hidup (activeLedgerRuntime != null) dengan footprint kecil', () => {
  const path = join(root, 'default.db')
  const runtime = startLedgerRuntime({ path })
  try {
    expect(runtime).not.toBe(null)
    expect(runtime!.mode).toBe('on')
    expect(activeLedgerRuntime()).toBe(runtime)
    expect(statSync(path).size < MAX_EMPTY_LEDGER_BYTES).toBe(true)
  } finally {
    runtime?.close()
  }
})

test('default turunan degradasi (null + warn) saat gagal buka; mode on eksplisit tetap melempar', () => {
  const bad = join(root, 'not-a-dir-default')
  writeFileSync(bad, 'occupied')
  expect(startLedgerRuntime({ path: join(bad, 'x.db') })).toBe(null)
  let threw = false
  try {
    startLedgerRuntime({ mode: 'on', path: join(bad, 'x.db') })
  } catch {
    threw = true // galat dilempar sebagaimana mestinya (mode eksplisit ketat)
  }
  expect(threw).toBe(true)
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

test('close() retires the runtime as the active one (no seam is left holding a closed DB)', () => {
  const first = startLedgerRuntime({ mode: 'on', path: ':memory:' })
  expect(activeLedgerRuntime()).toBe(first)
  first?.close()
  expect(activeLedgerRuntime()).toBe(null)
  const a = startLedgerRuntime({ mode: 'on', path: ':memory:' })
  const b = startLedgerRuntime({ mode: 'on', path: ':memory:' })
  a?.close() // closing a superseded runtime leaves the newer one active
  expect(activeLedgerRuntime()).toBe(b)
  b?.close()
  expect(activeLedgerRuntime()).toBe(null)
})
