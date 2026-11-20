// Real SQLite in memory (never the user's DB): the browser_profile table, its idempotent migration and the registry
// service over it. The Default profile of every existing board keeps the board id, so logins made before profiles survive.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserProfileStore, createMemoryProfileStore, ensureBrowserProfileTable } from './db.browserProfile'
import { Db, openDb } from './db'
import { createCookieVault } from './browser/cookieVault.store'
import { createProfilesService } from './browser/browser.profiles.service'
import { cookie } from './browser/browser.profiles.testkit'

const row = (id: string, name: string) => ({ id, name, color: 'red', shade: 'default', createdAt: 1, workspaceId: null })

test('openDb creates the table; running the migration again changes nothing', () => {
  const d = openDb(':memory:')
  const store = createBrowserProfileStore(d)
  expect(store.insert(row('bp-1', 'A'))).toBe(true)
  ensureBrowserProfileTable(d)
  ensureBrowserProfileTable(d)
  expect(store.list()).toEqual([row('bp-1', 'A')])
})

test('names are unique ignoring case; update refuses a taken name but allows the own one', () => {
  const store = createBrowserProfileStore(new Database(':memory:'))
  expect(store.insert(row('bp-1', 'Admin'))).toBe(true)
  expect(store.insert(row('bp-2', 'ADMIN'))).toBe(false)
  expect(store.insert(row('bp-1', 'Other'))).toBe(false) // id is unique too
  expect(store.insert(row('bp-3', 'Viewer'))).toBe(true)
  expect(store.update('bp-3', { name: 'admin' })).toBe(false)
  expect(store.update('bp-3', { name: 'Viewer', color: 'teal', shade: 'vivid' })).toBe(true)
  expect(store.get('bp-3')).toMatchObject({ name: 'Viewer', color: 'teal', shade: 'vivid' })
  expect(store.update('bp-ghost', { name: 'Z' })).toBe(false)
  expect(store.remove('bp-3')).toBe(true)
  expect(store.get('bp-3')).toBeNull()
})

test('boot migration: every stored board gets a Default profile with the board id; old vault stays readable; idempotent', () => {
  const d = openDb(':memory:')
  const db = new Db(d)
  const a = db.create('Alpha')
  const b = db.create('Beta')
  const dir = mkdtempSync(join(tmpdir(), 'bprofdb-'))
  const secrets = new Map<string, string>()
  const vault = createCookieVault({ secrets: { read: (k) => secrets.get(k) ?? null, write: (k, v) => void secrets.set(k, v), remove: (k) => void secrets.delete(k) }, baseDir: dir })
  vault.save(a.id, [cookie('legacy.com')]) // written by a build that keyed the vault by workspace id
  const svc = createProfilesService({
    store: db.browserProfiles(), workspaces: () => db.list(), vault, nodeProfileIds: () => [], isLive: () => false, changed: () => undefined,
  })
  svc.ensureDefaults()
  svc.ensureDefaults()
  const list = svc.list()
  expect(list.map((p) => p.id).sort()).toEqual([a.id, b.id].sort())
  expect(list.find((p) => p.id === a.id)).toMatchObject({ name: 'Default (Alpha)', isDefaultOf: a.id, workspaceId: a.id, cookieDomains: 1 })
  expect(vault.load(a.id).map((c) => c.domain)).toEqual(['legacy.com'])
  expect(db.browserProfiles().list()).toHaveLength(2) // second run inserted nothing
})

test('profiles sharing a createdAt list in creation order, not random-id order (both stores)', () => {
  for (const store of [createBrowserProfileStore(new Database(':memory:')), createMemoryProfileStore()]) {
    // ids descend while creation order ascends, so an id tie-break would reverse the list
    for (let i = 0; i < 12; i++) store.insert(row(`bp-${99 - i}`, `acct-${i}`))
    expect(store.list().map((r) => r.name)).toEqual(Array.from({ length: 12 }, (_, i) => `acct-${i}`))
  }
})
