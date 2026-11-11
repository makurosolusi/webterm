// Setup code: created once while no account exists, 0600, reused across restarts, consumed once.
import { afterAll, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearSetupCode, consumeSetupCode, ensureSetupCode, setupCodePath } from './setupCode'
import { createUserStore } from './uiUser'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'wt-setup-'))
  dirs.push(d)
  return d
}

test('lifecycle: create 0600, reuse, wrong code refused, right code consumed once', () => {
  const dir = tmp()
  const users = createUserStore(new Database(':memory:'))
  const path = ensureSetupCode(dir, users)
  expect(path).toBe(setupCodePath(dir))
  expect(statSync(path!).mode & 0o777).toBe(0o600)
  const code = readFileSync(path!, 'utf8')
  expect(code).toMatch(/^[0-9a-f]{32}$/)
  expect(ensureSetupCode(dir, users)).toBe(path) // a restart reuses it
  expect(readFileSync(path!, 'utf8')).toBe(code)
  expect(consumeSetupCode(dir, 'f'.repeat(32))).toBe(false)
  expect(consumeSetupCode(dir, '')).toBe(false)
  expect(existsSync(path!)).toBe(true)
  expect(consumeSetupCode(dir, ` ${code.toUpperCase()}\n`)).toBe(true)
  expect(existsSync(path!)).toBe(false)
  expect(consumeSetupCode(dir, code)).toBe(false) // single use
})

test('a malformed file is replaced; once an account exists the code is removed', async () => {
  const dir = tmp()
  const users = createUserStore(new Database(':memory:'))
  const path = ensureSetupCode(dir, users)!
  writeFileSync(path, 'hand edited', { mode: 0o600 })
  ensureSetupCode(dir, users)
  expect(readFileSync(path, 'utf8')).toMatch(/^[0-9a-f]{32}$/)
  await users.createOwner({ username: 'alice', password: 'correct horse battery' }) // test-only
  expect(ensureSetupCode(dir, users)).toBeNull()
  expect(existsSync(path)).toBe(false)
  clearSetupCode(dir) // absent file is fine
})
