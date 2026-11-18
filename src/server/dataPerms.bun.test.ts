// Bun-only (bun:sqlite lewat db.ts). Semua di mkdtemp /tmp + WEBTERM_DATA_DIR palsu; home tak disentuh.
import { test, expect, afterAll } from 'bun:test'
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'dataperms-'))
const savedDir = process.env.WEBTERM_DATA_DIR
// Harus diset sebelum db.ts diimpor: modul itu membuka DB default saat dimuat.
process.env.WEBTERM_DATA_DIR = join(root, 'boot')
const { dataDir } = await import('./config')
const { openDb } = await import('./db')
const modeOf = (p: string) => statSync(p).mode & 0o777

afterAll(() => {
  if (savedDir === undefined) delete process.env.WEBTERM_DATA_DIR
  else process.env.WEBTERM_DATA_DIR = savedDir
  // Not `root` itself: db.ts opened its default DB under `root/boot` when it was imported above, and every later test file in the
  // same bun process shares that open handle. Deleting it made them fail with SQLITE_IOERR_VNODE (dag.bun.test.ts, 15 tests,
  // when both ran in one test:impacted batch). Only the directories this file made for itself are removed; `boot` is a few KB in /tmp.
  for (const name of readdirSync(root)) if (name !== 'boot') rmSync(join(root, name), { recursive: true, force: true })
})

test('dir baru dibuat 0700', () => {
  process.env.WEBTERM_DATA_DIR = join(root, 'a', 'b')
  expect(modeOf(dataDir())).toBe(0o700)
})

test('dir lama 0755 milik sendiri diperketat ke 0700', () => {
  const d = join(root, 'old')
  mkdirSync(d)
  chmodSync(d, 0o755)
  process.env.WEBTERM_DATA_DIR = d
  dataDir()
  expect(modeOf(d)).toBe(0o700)
})

test('dir bukan milik uid proses dibiarkan: tidak throw, mode tak berubah', () => {
  const shared = '/tmp' // dimiliki root (sticky), bukan hak kita
  const before = modeOf(shared)
  process.env.WEBTERM_DATA_DIR = shared
  expect(dataDir()).toBe(shared)
  expect(modeOf(shared)).toBe(before)
})

test('openDb: berkas DB 0600 (dan -wal/-shm mewarisi)', () => {
  const p = join(root, 'x.db')
  const d = openDb(p)
  d.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS t(x); INSERT INTO t VALUES (1)')
  expect(modeOf(p)).toBe(0o600)
  expect(modeOf(`${p}-wal`)).toBe(0o600)
})

function captureStderr(fn: () => void): string {
  const writes: string[] = []
  const orig = process.stderr.write
  process.stderr.write = ((s: string) => (writes.push(String(s)), true)) as typeof process.stderr.write
  try { fn() } catch { /* galat lanjutan dari sqlite diabaikan: yang diuji hanya keluaran stderr */ } finally { process.stderr.write = orig }
  return writes.join('')
}

test(':memory: tidak menyentuh izin berkas apa pun (stderr kosong)', () => {
  expect(captureStderr(() => openDb(':memory:'))).toBe('')
})

test('chmod gagal (berkas bukan milik kita) tidak menjatuhkan boot: stderr hanya kode errno', () => {
  process.env.WEBTERM_SECRET_PROBE = 'sekret-nilai-env'
  // /dev/null: dimiliki root, chmod => EPERM. sqlite lalu gagal sendiri; yang dicek: chmod tidak melempar.
  const out = captureStderr(() => openDb('/dev/null'))
  delete process.env.WEBTERM_SECRET_PROBE
  expect(out).toBe('[webterm] data dir permissions not tightened (EPERM)\n')
  expect(out).not.toContain('sekret-nilai-env')
})
