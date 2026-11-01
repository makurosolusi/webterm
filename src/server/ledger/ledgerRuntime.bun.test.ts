import { mkdtempSync, rmSync } from 'node:fs'
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
  const bad = join(root, 'not-a-dir')
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
