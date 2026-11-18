import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WORKSPACE_HUES } from '../../shared/workspaceColor'
import { isBrowserProfileId, matchProfileRef, resolveProfileId, validateProfileName } from '../../shared/browser.profile'
import { cookie, makeRig, ws } from './browser.profiles.testkit'
import { duplicateProfile, exportCookies, removeProfile } from './browser.profiles.ops'
import { parseCookies } from './cookieImport.parse'
import { profileDir, vaultFile } from './profile.paths'

describe('shared contract', () => {
  it('validates names: trimmed, non-empty, bounded, no control characters', () => {
    expect(validateProfileName('  Admin  ')).toEqual({ ok: true, name: 'Admin' })
    for (const bad of ['', '   ', 'x'.repeat(41), 'a\nb', 7, undefined]) expect(validateProfileName(bad)).toEqual({ ok: false, code: 'profile_name_invalid' })
  })
  it('profile ids are one safe path segment and never shadow an API route', () => {
    for (const bad of ['../x', 'a/b', '', 'profiles', 'status', 'a'.repeat(65), '.hidden']) expect(isBrowserProfileId(bad)).toBe(false)
    expect(isBrowserProfileId('bp-0123abcd')).toBe(true)
  })
  it('resolveProfileId: own profileId, else the workspace Default (id = workspace id)', () => {
    expect(resolveProfileId('w1', { profileId: 'bp-1' })).toBe('bp-1')
    expect(resolveProfileId('w1', {})).toBe('w1')
    expect(resolveProfileId('w1', { profileId: '../evil' })).toBe('w1')
    expect(resolveProfileId('w1')).toBe('w1')
  })
  it('matchProfileRef: id or case-insensitive name; another board\'s profile does not shadow a global one', () => {
    const p = (id: string, name: string, workspaceId: string | null) => ({ id, name, color: 'red', shade: 'default', createdAt: 0, workspaceId, live: false, nodeCount: 0, cookieDomains: 0 })
    const all = [p('a', 'Admin', 'w2'), p('b', 'admin', null)]
    expect(matchProfileRef(all, 'ADMIN', 'w1')?.id).toBe('b')
    expect(matchProfileRef(all, 'a', 'w1')?.id).toBe('a')
    expect(matchProfileRef(all, 'nope')).toBeUndefined()
  })
})

describe('default profiles (migration)', () => {
  it('gives every board a Default profile whose id is the workspace id, idempotently', () => {
    const rig = makeRig()
    rig.svc.ensureDefaults()
    rig.svc.ensureDefaults()
    const list = rig.svc.list()
    expect(list.map((p) => [p.id, p.name, p.isDefaultOf])).toEqual([['w1', 'Default (Alpha)', 'w1'], ['w2', 'Default (Beta)', 'w2']])
    expect(rig.changes).toBe(1) // announced once, not on every boot
  })
  it('keeps a pre-existing vault readable and counts its domains (AAD stays the workspace id)', () => {
    const rig = makeRig()
    rig.vault.save('w1', [cookie('a.com'), cookie('b.com')]) // what an old build wrote
    mkdirSync(profileDir('w1', rig.base), { recursive: true })
    expect(rig.svc.list().find((p) => p.id === 'w1')?.cookieDomains).toBe(2)
    expect(existsSync(vaultFile('w1', rig.base))).toBe(true) // nothing moved or renamed
  })
  it('two boards with the same name still get unique profile names', () => {
    const rig = makeRig([ws('w1', 'Same'), ws('w2', 'Same')])
    expect(rig.svc.list().map((p) => p.name)).toEqual(['Default (Same)', 'Default (Same 2)'])
  })
  it('scopes the list to a board: its Default plus global profiles, not other boards\' Defaults', () => {
    const rig = makeRig()
    rig.svc.ensureDefaults()
    const g = rig.svc.create({ name: 'Global' })
    expect(g.ok).toBe(true)
    expect(rig.svc.list('w1').map((p) => p.name).sort()).toEqual(['Default (Alpha)', 'Global'])
  })
})

describe('create / update', () => {
  it('creates with a random unused hue and a unique name (case-insensitive)', () => {
    const rig = makeRig()
    rig.svc.ensureDefaults()
    const used = new Set(rig.svc.list().map((p) => p.color))
    const a = rig.svc.create({ name: 'Admin' })
    if (!a.ok) throw new Error(a.code)
    expect(WORKSPACE_HUES).toContain(a.value.color)
    expect(used.has(a.value.color)).toBe(false)
    expect(a.value.id).toMatch(/^bp-[0-9a-f]{12}$/)
    expect(a.value.workspaceId).toBeNull()
    expect(rig.svc.create({ name: ' ADMIN ' })).toEqual({ ok: false, code: 'profile_name_taken' })
    expect(rig.svc.create({ name: '' })).toEqual({ ok: false, code: 'profile_name_invalid' })
    expect(rig.svc.create({ name: 'X', color: 'neon' })).toEqual({ ok: false, code: 'bad_request' })
    expect(rig.svc.create({ name: 'Y', workspaceId: 'ghost' })).toEqual({ ok: false, code: 'bad_request' })
  })
  it('renames and recolors; a taken name or unknown id fails with its code', () => {
    const rig = makeRig()
    const a = rig.svc.create({ name: 'A' })
    const b = rig.svc.create({ name: 'B' })
    if (!a.ok || !b.ok) throw new Error('create')
    expect(rig.svc.update(a.value.id, { name: 'b' })).toEqual({ ok: false, code: 'profile_name_taken' })
    expect(rig.svc.update(a.value.id, { name: 'A2', color: 'teal', shade: 'vivid' })).toMatchObject({ ok: true, value: { name: 'A2', color: 'teal', shade: 'vivid' } })
    expect(rig.svc.update(a.value.id, { name: 'A2' })).toMatchObject({ ok: true }) // own name is not "taken"
    expect(rig.svc.update('bp-nope', { name: 'Z' })).toEqual({ ok: false, code: 'profile_not_found' })
  })
  it('an agent-made change leaves a ledger note; a human one does not need one', () => {
    const rig = makeRig()
    rig.svc.create({ name: 'ByAgent' }, 'agent')
    expect(rig.notes).toEqual(['agent:created browser profile "ByAgent"'])
  })
  it('resolve finds by name ignoring case', () => {
    const rig = makeRig()
    rig.svc.create({ name: 'Finance' })
    expect(rig.svc.resolve('finance')?.name).toBe('Finance')
  })
})

describe('delete', () => {
  it('is refused while a node uses the profile, and for a live Default whose board exists', () => {
    const rig = makeRig([ws('w1', 'Alpha', [{ id: 'b1', kind: 'browser', x: 0, y: 0 }])])
    const a = rig.svc.create({ name: 'A' })
    if (!a.ok) throw new Error('create')
    rig.boards[0].nodes.push({ id: 'b2', kind: 'browser', x: 0, y: 0, profileId: a.value.id })
    expect(removeProfile(rig.ops, a.value.id)).toEqual({ ok: false, code: 'profile_in_use' })
    expect(removeProfile(rig.ops, 'w1')).toEqual({ ok: false, code: 'profile_default' })
    expect(removeProfile(rig.ops, 'bp-nope')).toEqual({ ok: false, code: 'profile_not_found' })
    rig.boards[0].nodes.pop()
    expect(removeProfile(rig.ops, a.value.id)).toEqual({ ok: true, value: null })
    expect(rig.stopped).toEqual([a.value.id])
  })
  it('wipes the profile dir and the vault', () => {
    const rig = makeRig()
    const a = rig.svc.create({ name: 'A' })
    if (!a.ok) throw new Error('create')
    mkdirSync(profileDir(a.value.id, rig.base), { recursive: true })
    writeFileSync(join(profileDir(a.value.id, rig.base), 'Cookies'), 'x')
    rig.vault.save(a.value.id, [cookie('a.com')])
    removeProfile(rig.ops, a.value.id)
    expect(existsSync(profileDir(a.value.id, rig.base))).toBe(false)
    expect(existsSync(vaultFile(a.value.id, rig.base))).toBe(false)
    expect(rig.svc.deps.store.get(a.value.id)).toBeNull()
  })
})

describe('duplicate / export', () => {
  it('copies dir (without process locks) and vault into a standalone profile; the source stays intact', () => {
    const rig = makeRig()
    const a = rig.svc.create({ name: 'A' })
    if (!a.ok) throw new Error('create')
    const src = profileDir(a.value.id, rig.base)
    mkdirSync(join(src, 'Default'), { recursive: true })
    writeFileSync(join(src, 'Default', 'Cookies'), 'session-db')
    writeFileSync(join(src, 'SingletonLock'), 'pid')
    rig.vault.save(a.value.id, [cookie('a.com', 'sid', 'secret-1')])
    const d = duplicateProfile(rig.ops, a.value.id, 'A copy')
    if (!d.ok) throw new Error(d.code)
    expect(d.value.id).not.toBe(a.value.id)
    const dst = profileDir(d.value.id, rig.base)
    expect(existsSync(join(dst, 'Default', 'Cookies'))).toBe(true)
    expect(existsSync(join(dst, 'SingletonLock'))).toBe(false)
    expect(rig.vault.load(d.value.id).map((c) => c.value)).toEqual(['secret-1'])
    expect(rig.vault.load(a.value.id)).toHaveLength(1)
    rig.vault.clear(a.value.id)
    expect(rig.vault.load(d.value.id)).toHaveLength(1) // standalone: its own blob under its own AAD
  })
  it('is refused while the source browser runs, and for a bad name', () => {
    const rig = makeRig()
    const a = rig.svc.create({ name: 'A' })
    if (!a.ok) throw new Error('create')
    rig.live.add(a.value.id)
    expect(duplicateProfile(rig.ops, a.value.id, 'B')).toEqual({ ok: false, code: 'profile_live' })
    rig.live.clear()
    expect(duplicateProfile(rig.ops, a.value.id, '')).toEqual({ ok: false, code: 'profile_name_invalid' })
    expect(duplicateProfile(rig.ops, a.value.id, 'a')).toEqual({ ok: false, code: 'profile_name_taken' })
    expect(rig.svc.list().map((p) => p.name).filter((n) => !n.startsWith('Default'))).toEqual(['A']) // no half-made copy left behind
  })
  it('export re-imports through the importer unchanged (round trip)', () => {
    const rig = makeRig()
    const a = rig.svc.create({ name: 'A' })
    if (!a.ok) throw new Error('create')
    const cookies = [cookie('a.com', 'sid', 'v1'), cookie('b.com', 'tok', 'v2')]
    rig.vault.save(a.value.id, cookies)
    const out = exportCookies(rig.ops, a.value.id)
    if (!out.ok) throw new Error(out.code)
    const back = parseCookies('storageState', out.value)
    expect(back.sort((x, y) => x.domain.localeCompare(y.domain))).toMatchObject(cookies)
  })
})
