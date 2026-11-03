// ES-14 matriks legacy: kunci env lama tersimpan di DB sementara (tabel `app`) -> overlay -> himpunan kemampuan tepat.
// DB dan data dir hanya di os.tmpdir(); home pengguna tak disentuh.
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { CAPABILITY_IDS, type CapabilityId } from '../shared/featureCapabilities'
import { openDb } from './db'
import { BOOTSTRAP_ONLY_KEYS, ENV_REGISTRY } from './envRegistry'
import { createEnvSettings } from './envSettings.service'
import { createAppRowOverrideStore, ENV_OVERRIDES_ROW } from './envSettings.store'
import { enabledSet } from './featureCapabilities.runtime'
import { legacyToCapabilities } from './featureCapabilities.legacy'
import { logBus } from './logs'

const C = 'WEBTERM_CENTRAL'
const W = 'WEBTERM_ORCHESTRATOR_RUN'
const A = 'WEBTERM_CENTRAL_AUTONOMY'
const F = 'WEBTERM_FILES_VIEWERS'
const M = 'WEBTERM_FILES_MUTATE'
const T = 'WEBTERM_TELEGRAM'
const on = 'on'

interface Case { name: string; stored: Record<string, string>; set: CapabilityId[]; ignored: string[] }
// test-only: tabel kasus kunci lama -> himpunan kemampuan (b section 9); ignored = kunci tanpa induk aktif.
const CASES: Case[] = [
  { name: 'store kosong', stored: {}, set: [], ignored: [] },
  { name: 'central saja', stored: { [C]: on }, set: ['central'], ignored: [] },
  { name: 'workers tanpa central', stored: { [W]: on }, set: [], ignored: [W] },
  { name: 'central + workers', stored: { [C]: on, [W]: on }, set: ['central', 'workers'], ignored: [] },
  { name: 'autonomy tanpa workers', stored: { [C]: on, [A]: on }, set: ['central'], ignored: [A] },
  { name: 'rantai central-workers-autonomy', stored: { [A]: on, [W]: on, [C]: on }, set: ['central', 'workers', 'autonomy'], ignored: [] },
  { name: 'browser', stored: { WEBTERM_BROWSER: on }, set: ['browser'], ignored: [] },
  { name: 'files viewers', stored: { [F]: on }, set: ['files'], ignored: [] },
  { name: 'files mutate tanpa viewers', stored: { [M]: on }, set: [], ignored: [M] },
  { name: 'files viewers + mutate', stored: { [F]: on, [M]: on }, set: ['files', 'filesWrite'], ignored: [] },
  { name: 'telegram saja', stored: { [T]: on }, set: ['telegram'], ignored: [] },
  { name: 'channels tanpa telegram', stored: { WEBTERM_CHANNELS: on }, set: [], ignored: ['WEBTERM_CHANNELS'] },
  { name: 'central_telegram tanpa telegram', stored: { [C]: on, WEBTERM_CENTRAL_TELEGRAM: on }, set: ['central'], ignored: ['WEBTERM_CENTRAL_TELEGRAM'] },
  { name: 'central + telegram + jembatan', stored: { [C]: on, [T]: on, WEBTERM_CENTRAL_TELEGRAM: on }, set: ['central', 'telegram'], ignored: [] },
  { name: 'files_watch tanpa files', stored: { WEBTERM_FILES_WATCH: on }, set: [], ignored: ['WEBTERM_FILES_WATCH'] },
  { name: 'ledger lama diabaikan senyap', stored: { WEBTERM_LEDGER: on }, set: [], ignored: [] },
  { name: 'semua tujuh', stored: { [C]: on, [W]: on, [A]: on, WEBTERM_BROWSER: on, [F]: on, [M]: on, [T]: on }, set: [...CAPABILITY_IDS], ignored: [] },
  { name: 'nilai off tak menyalakan', stored: { [C]: 'off', [W]: 'off', [F]: 'off' }, set: [], ignored: [] },
]

const dir = mkdtempSync(join(tmpdir(), 'wt-legacy-matrix-'))

/** Simpan kunci lama di DB baru, jalankan overlay produksi ke env kosong, kembalikan env hasilnya. */
function envFromStore(idx: number, stored: Record<string, string>): NodeJS.ProcessEnv {
  const db = openDb(join(dir, `case-${idx}.db`))
  try {
    db.query('INSERT INTO app (key, value) VALUES (?, ?)').run(ENV_OVERRIDES_ROW, JSON.stringify(stored))
    const target: NodeJS.ProcessEnv = {}
    const secrets = { read: () => null, write: () => undefined, remove: () => undefined }
    createEnvSettings({ registry: ENV_REGISTRY, bootstrapKeys: BOOTSTRAP_ONLY_KEYS, target, overrides: createAppRowOverrideStore(db), secrets }).apply()
    return target
  } finally {
    (db as unknown as { close(): void }).close() // tipe bun:sqlite di repo ini tak mengekspos close
  }
}

test('matriks memuat sedikitnya 12 kasus dan menyentuh ketujuh kemampuan', () => {
  expect(CASES.length >= 12).toBe(true)
  const touched = new Set(CASES.flatMap((c) => c.set))
  expect([...touched].sort()).toEqual([...CAPABILITY_IDS].sort())
})

test('kunci lama di DB -> himpunan kemampuan tepat, enabledSet sama dengan legacyToCapabilities', () => {
  CASES.forEach((c, idx) => {
    const env = envFromStore(idx, c.stored)
    const got = legacyToCapabilities(env)
    expect({ name: c.name, set: [...got.set].sort() }).toEqual({ name: c.name, set: [...c.set].sort() })
    expect({ name: c.name, ignored: got.ignored.sort() }).toEqual({ name: c.name, ignored: [...c.ignored].sort() })
    expect({ name: c.name, on: [...enabledSet(env)].sort() }).toEqual({ name: c.name, on: [...c.set].sort() })
  })
})

test('dialek flag dari env proses (1/true/ON) dikenali; yes/2 tidak; store hanya menerima on/off', () => {
  const env = { [C]: '1', [W]: ' TRUE ', WEBTERM_BROWSER: 'ON', [F]: 'yes', [T]: '2' }
  expect([...legacyToCapabilities(env).set].sort()).toEqual(['browser', 'central', 'workers'])
  expect([...enabledSet(envFromStore(300, { [C]: '1' }))]).toEqual([]) // store menolak nilai non-kanonik
})

test('urutan kunci tersimpan tak berpengaruh', () => {
  const full = CASES.find((c) => c.name === 'semua tujuh') as Case
  const reversed = Object.fromEntries(Object.entries(full.stored).reverse())
  const a = legacyToCapabilities(envFromStore(100, full.stored))
  const b = legacyToCapabilities(envFromStore(101, reversed))
  expect(b).toEqual(a)
})

test('satu warn per kunci yang diabaikan, hanya nama kunci, walau dipanggil berulang', () => {
  const ignoredKeys = [...new Set(CASES.flatMap((c) => c.ignored))]
  expect(ignoredKeys.length >= 5).toBe(true)
  CASES.forEach((c, idx) => legacyToCapabilities(envFromStore(200 + idx, c.stored))) // putaran kedua
  const warns = logBus.query().filter((e) => e.event === 'capability.legacy_ignored')
  const perKey = new Map<string, number>()
  for (const e of warns) perKey.set(String(e.data?.key), (perKey.get(String(e.data?.key)) ?? 0) + 1)
  expect(ignoredKeys.map((k) => [k, perKey.get(k)])).toEqual(ignoredKeys.map((k) => [k, 1]))
  for (const e of warns) expect(Object.keys(e.data ?? {})).toEqual(['key'])
})

test('bersihkan DB sementara', () => {
  rmSync(dir, { recursive: true, force: true })
  expect(existsSync(dir)).toBe(false)
})
