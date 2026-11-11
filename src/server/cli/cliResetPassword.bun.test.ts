// `webterm --reset-password` through the real entry, in a temp data dir: password from stdin, exit
// codes, sessions revoked, no secret on stdout/stderr, server never started.
import { afterAll, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUiSessionStore } from '../uiSession'
import { createUserStore } from '../uiUser'

const ENTRY = join(import.meta.dirname, '../index.ts')
const RUN_TIMEOUT_MS = 20_000
const OLD_PW = 'old password long enough' // test-only
const NEW_PW = 'brand new password 42' // test-only
const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

async function seeded(): Promise<{ home: string; dataDir: string; session: string }> {
  const home = mkdtempSync(join(tmpdir(), 'wt-reset-'))
  dirs.push(home)
  const dataDir = join(home, 'data')
  mkdirSync(dataDir)
  const db = new Database(join(dataDir, 'webterm.db'))
  await createUserStore(db).createOwner({ username: 'alice', password: OLD_PW })
  const session = createUiSessionStore(db).create({ userId: 1 })
  db.close()
  return { home, dataDir, session }
}

function run(box: { home: string; dataDir: string }, args: string[], input: string) {
  const r = spawnSync(process.execPath, ['--no-env-file', ENTRY, ...args], {
    cwd: box.home, encoding: 'utf8', timeout: RUN_TIMEOUT_MS, input,
    env: { HOME: box.home, WEBTERM_DATA_DIR: box.dataDir, PATH: process.env.PATH ?? '' },
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

test('stdin password resets the hash, revokes sessions, prints no secret, exits 0', async () => {
  const box = await seeded()
  const r = run(box, ['--reset-password', 'ALICE'], `${NEW_PW}\n`)
  expect(r.err).toBe('')
  expect(r.code).toBe(0)
  expect(r.out).toContain('Password reset')
  expect(r.out + r.err).not.toContain(NEW_PW)
  expect(r.out + r.err).not.toContain('alice')
  const db = new Database(join(box.dataDir, 'webterm.db'))
  const users = createUserStore(db)
  expect(await users.verifyLogin('alice', OLD_PW)).toBeNull()
  expect((await users.verifyLogin('alice', NEW_PW))?.id).toBe(1)
  expect(createUiSessionStore(db).verify(box.session)).toBe(false)
  db.close()
}, RUN_TIMEOUT_MS)

test('unknown user exits 1; weak or missing password exits 2; usage exits 2', async () => {
  const box = await seeded()
  expect(run(box, ['--reset-password', 'bob'], `${NEW_PW}\n`).code).toBe(1)
  const weak = run(box, ['--reset-password', 'alice'], 'short\n')
  expect(weak.code).toBe(2)
  expect(weak.err).toContain('at least 12')
  expect(run(box, ['--reset-password', 'alice'], '').code).toBe(2)
  expect(run(box, ['--reset-password'], '').code).toBe(2)
  const db = new Database(join(box.dataDir, 'webterm.db'))
  expect((await createUserStore(db).verifyLogin('alice', OLD_PW))?.id).toBe(1) // untouched
  db.close()
}, RUN_TIMEOUT_MS)

test('a data dir without a database exits 1 and creates no database', () => {
  const home = mkdtempSync(join(tmpdir(), 'wt-reset-'))
  dirs.push(home)
  const r = run({ home, dataDir: join(home, 'data') }, ['--reset-password', 'alice'], `${NEW_PW}\n`)
  expect(r.code).toBe(1)
  expect(spawnSync('ls', [join(home, 'data')], { encoding: 'utf8' }).stdout).toBe('')
}, RUN_TIMEOUT_MS)
