// Account store: owner race, validation, login (incl. unknown user and rehash), password/name changes.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { AuthError, PASSWORD_MAX_BYTES, createUserStore } from './uiUser'

declare const Bun: { password: { hash(pw: string, o?: { algorithm: 'argon2id'; memoryCost: number; timeCost: number }): Promise<string> } }

const TMP = mkdtempSync(join(tmpdir(), 'wt-uiuser-'))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))
const PW = 'correct horse battery' // test-only
const PW2 = 'another long passphrase' // test-only
const fresh = () => {
  const db = new Database(':memory:')
  return { db, users: createUserStore(db, () => 1000) }
}
/** The AuthError code a promise (or call) fails with, or 'ok'. */
async function codeOf(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof p === 'function' ? p() : p)
    return 'ok'
  } catch (e) {
    if (e instanceof AuthError) return e.code
    throw e
  }
}
const hashOf = (db: Database, id: number) => (db.query('SELECT pw_hash FROM ui_user WHERE id = ?').get(id) as { pw_hash: string }).pw_hash

describe('createOwner', () => {
  test('two concurrent calls: exactly one wins, the other is already_setup', async () => {
    const { users } = fresh()
    const r = await Promise.all([codeOf(users.createOwner({ username: 'alice', password: PW })), codeOf(users.createOwner({ username: 'bob', password: PW }))])
    expect(r.sort()).toEqual(['already_setup', 'ok'])
    expect(users.count()).toBe(1)
  })
  test('two stores on one file race the same way', async () => {
    const path = join(TMP, 'webterm.db')
    const a = createUserStore(new Database(path)), b = createUserStore(new Database(path))
    const r = await Promise.all([codeOf(a.createOwner({ username: 'alice', password: PW })), codeOf(b.createOwner({ username: 'alice', password: PW }))])
    expect(r.sort()).toEqual(['already_setup', 'ok'])
  })
  test('validates username and password', async () => {
    const { users } = fresh()
    expect(await codeOf(users.createOwner({ username: 'ab', password: PW }))).toBe('invalid_username')
    expect(await codeOf(users.createOwner({ username: 'a b c', password: PW }))).toBe('invalid_username')
    expect(await codeOf(users.createOwner({ username: 'x'.repeat(33), password: PW }))).toBe('invalid_username')
    expect(await codeOf(users.createOwner({ username: 'alice', password: 'short pw' }))).toBe('weak_password')
    expect(await codeOf(users.createOwner({ username: 'alice', password: 'é'.repeat(PASSWORD_MAX_BYTES / 2 + 1) }))).toBe('weak_password')
    expect(await codeOf(users.createOwner({ username: 'alice', password: '123456789012' }))).toBe('ok') // no composition rules
    const u = users.get(1)
    expect(u).toEqual({ id: 1, username: 'alice', createdAt: 1000, pwChangedAt: 1000 })
    expect(users.sole()).toEqual(u)
  })
})

describe('verifyLogin', () => {
  test('success is case-insensitive on the name; wrong password, unknown and odd names are null', async () => {
    const { users } = fresh()
    await users.createOwner({ username: 'Alice', password: PW })
    expect((await users.verifyLogin('alice', PW))?.id).toBe(1)
    expect(await users.verifyLogin('Alice', 'wrong password!!')).toBeNull()
    expect(await users.verifyLogin('nobody', PW)).toBeNull()
    expect(await users.verifyLogin('', '')).toBeNull()
    expect(await users.verifyLogin('Alice', 'x'.repeat(PASSWORD_MAX_BYTES + 1))).toBeNull()
  })
  test('an old-cost hash is upgraded on a successful login', async () => {
    const { db, users } = fresh()
    await users.createOwner({ username: 'alice', password: PW })
    const weak = await Bun.password.hash(PW, { algorithm: 'argon2id', memoryCost: 4096, timeCost: 1 })
    db.query('UPDATE ui_user SET pw_hash = ? WHERE id = 1').run(weak)
    expect(await users.verifyLogin("alice", "nope nope nope")).toBeNull()
    expect(hashOf(db, 1)).toBe(weak) // failure never rehashes
    expect((await users.verifyLogin('alice', PW))?.id).toBe(1)
    expect(hashOf(db, 1)).not.toBe(weak)
    expect(hashOf(db, 1)).toContain('m=65536')
    expect((await users.verifyLogin('alice', PW))?.id).toBe(1)
  })
})

describe('changes', () => {
  test('changePassword checks the current password and the new rules', async () => {
    let t = 1000
    const users = createUserStore(new Database(':memory:'), () => t)
    const { id } = await users.createOwner({ username: 'alice', password: PW })
    t = 2000
    expect(await codeOf(users.changePassword(id, 'wrong password!', PW2))).toBe('invalid_credentials')
    expect(await codeOf(users.changePassword(id, PW, 'short'))).toBe('weak_password')
    expect(await codeOf(users.changePassword(99, PW, PW2))).toBe('not_found')
    expect(await codeOf(users.changePassword(id, PW, PW2))).toBe('ok')
    expect(users.get(id)?.pwChangedAt).toBe(2000)
    expect(await users.verifyLogin('alice', PW)).toBeNull()
    expect((await users.verifyLogin('alice', PW2))?.id).toBe(id)
  })
  test('rename needs the password, a valid name, and a free name', async () => {
    const { db, users } = fresh()
    const { id } = await users.createOwner({ username: 'alice', password: PW })
    db.query("INSERT INTO ui_user (username, pw_hash, created_at, pw_changed_at) VALUES ('bob', 'x', 1, 1)").run()
    expect(await codeOf(users.rename(id, 'carol', 'wrong password!'))).toBe('invalid_credentials')
    expect(await codeOf(users.rename(id, 'c', PW))).toBe('invalid_username')
    expect(await codeOf(users.rename(id, 'BOB', PW))).toBe('username_taken')
    expect((await users.rename(id, 'ALICE', PW)).username).toBe('ALICE') // own name, other case
    expect((await users.rename(id, 'carol', PW)).username).toBe('carol')
    expect(users.sole()).toBeNull() // two accounts now
  })
  test('resetPassword (async and sync) needs no current password', async () => {
    const { users } = fresh()
    await users.createOwner({ username: 'alice', password: PW })
    expect(await codeOf(users.resetPassword('nobody', PW2))).toBe('not_found')
    expect(await codeOf(users.resetPassword('alice', 'short'))).toBe('weak_password')
    expect((await users.resetPassword('ALICE', PW2)).id).toBe(1)
    expect((await users.verifyLogin('alice', PW2))?.id).toBe(1)
    expect(await codeOf(() => users.resetPasswordSync('nobody', PW))).toBe('not_found')
    users.resetPasswordSync('alice', PW)
    expect((await users.verifyLogin('alice', PW))?.id).toBe(1)
  })
})
