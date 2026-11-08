// Paritas registry env vs pembaca: (1) default registry = hasil resolver publik pembaca dengan env kosong,
// (2) hot:true hanya untuk kunci yang pembacanya membaca env saat dipakai (HOT_PROOF). Lihat SETTINGS-AUDIT-b.md 9.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { maxInflightFromEnv } from './central/autonomyDispatch'
import { resolveLimits } from './central/chat/turnLimits'
import { READ_TOOLS_FLAG } from './central/tools/defs/read.shared'
import { contextWindowTokens } from './central/context/rotationPolicy'
import { budgetLimits } from './central/guard/budgetStore'
import { CA2_ENV_SPECS } from './envRegistry.ca2'
import { ENV_REGISTRY, specFor } from './envRegistry'
import { filesListMax } from './envRegistry.files'
import { parseCapacity } from './logs/logBus'
import { idleDoneMs } from './orchestrator/workerSignal'

const SERVER_DIR = new URL('.', import.meta.url).pathname
const EMPTY: Record<string, string | undefined> = {}

/**
 * Kunci hot -> pembaca (relatif ke src/server) yang membaca env pada saat dipakai, bukan salinan boot.
 * Rantai env hidup: TurnService/controlGuard/contextAssembler menerima `process.env` itu sendiri (override
 * Pengaturan memutasi process.env, envSettings.runtime.ts), lalu resolver di bawah dipanggil per turn/per cek.
 */
const HOT_PROOF: Readonly<Record<string, string>> = {
  WEBTERM_CENTRAL_TURN_STEPS: 'central/chat/turnLimits.ts',
  WEBTERM_CENTRAL_TURN_WALL_MS: 'central/chat/turnLimits.ts',
  WEBTERM_CENTRAL_DAILY_TOKENS: 'central/guard/budgetStore.ts',
  WEBTERM_CENTRAL_DAILY_SPAWNS: 'central/guard/budgetStore.ts',
  WEBTERM_CENTRAL_DAILY_COST_MICROS: 'central/guard/budgetStore.ts',
  WEBTERM_CENTRAL_CONTEXT_WINDOW: 'central/context/rotationPolicy.ts',
  WEBTERM_AGENT_IDLE_DONE_MS: 'orchestrator/workerSignal.ts',
  // Turunan Central: tool baca didaftarkan saat Central menyala (ca2Boot onCapabilityChange) dan `def.flag` dicek
  // per panggilan (toolTypes defEnabled). Nama kuncinya diturunkan, bukan literal: lihat DERIVED_KEY_SOURCE.
  WEBTERM_CENTRAL_READ_TOOLS: 'central/tools/defs/read.shared.ts',
  // Sub-switch of the Central card: setSub restarts Central, whose start re-reads the key and builds or drops the skill store.
  WEBTERM_CENTRAL_SKILLS: 'featureCapabilities.service.ts',
  // Same sub-switch path as SKILLS: setSub restarts Central, whose start re-reads it (ca2Boot).
  WEBTERM_CENTRAL_SKILL_PROPOSE: 'featureCapabilities.service.ts',
  // Re-read every turn from the turn's env (contextAssembler buildContext, turnContextLog).
  WEBTERM_CENTRAL_CHECKPOINT: 'central/context/contextAssembler.ts',
}

/** Kunci yang pembacanya memakai nama turunan (`derivedFlagKey`): teks sumber yang membuktikannya. */
const DERIVED_KEY_SOURCE: Readonly<Record<string, string>> = {
  WEBTERM_CENTRAL_READ_TOOLS: "derivedFlagKey('READ_TOOLS')",
}

/** Resolver publik pembaca dipanggil dengan env kosong; hasilnya harus sama dengan default registry. */
const PARITY: Readonly<Record<string, () => number>> = {
  WEBTERM_CENTRAL_TURN_STEPS: () => resolveLimits({}).maxTurns ?? NaN,
  WEBTERM_CENTRAL_TURN_WALL_MS: () => resolveLimits({}).maxWallMs ?? NaN,
  // budgetLimits membaca default dari registry sendiri, jadi paritas ini tautologis; dijaga agar tak diam-diam berubah.
  WEBTERM_CENTRAL_DAILY_TOKENS: () => budgetLimits(EMPTY).tokens,
  WEBTERM_CENTRAL_DAILY_SPAWNS: () => budgetLimits(EMPTY).spawns,
  WEBTERM_CENTRAL_DAILY_COST_MICROS: () => budgetLimits(EMPTY).costMicros,
  WEBTERM_CENTRAL_CONTEXT_WINDOW: () => contextWindowTokens(EMPTY),
  WEBTERM_AGENT_IDLE_DONE_MS: () => idleDoneMs(EMPTY),
  WEBTERM_CENTRAL_MAX_INFLIGHT: () => maxInflightFromEnv(''),
  WEBTERM_FILES_LIST_MAX: () => filesListMax(EMPTY),
  WEBTERM_LOG_BUFFER: () => parseCapacity(undefined),
}

/** Kunci angka tanpa resolver publik yang bisa dipanggil di sini (alasan wajib). */
const NO_PUBLIC_READER: Readonly<Record<string, string>> = {
  WEBTERM_FILES_UPLOAD_MAX_MB: 'Pembaca filesUploadMaxBytes mengembalikan byte; default registry diimpor dari konstanta MB yang sama.',
  WEBTERM_BROWSER_MAX_LIVE: 'Default registry diimpor dari konstanta kontrak bersama (shared/browser.contract) yang juga dipakai pembaca.',
  WEBTERM_BROWSER_DISCARD_MS: 'Default registry diimpor dari konstanta kontrak bersama (shared/browser.contract) yang juga dipakai pembaca.',
  WEBTERM_BROWSER_COOKIE_TTL_DAYS: 'Default registry diimpor dari konstanta kontrak bersama (shared/browser.contract) yang juga dipakai pembaca.',
}

describe('paritas default registry vs pembaca', () => {
  it.each(Object.entries(PARITY))('%s: resolver env kosong = default registry', (key, read) => {
    expect(String(read()), key).toBe(specFor(key)?.default)
  })
  it('tiap kunci angka registry punya paritas atau alasan NO_PUBLIC_READER', () => {
    const numeric = ENV_REGISTRY.filter((s) => s.kind === 'number').map((s) => s.key)
    expect(numeric.filter((k) => !(k in PARITY) && !(k in NO_PUBLIC_READER))).toEqual([])
    for (const [k, reason] of Object.entries(NO_PUBLIC_READER)) {
      expect(specFor(k)?.kind, k).toBe('number')
      expect(k in PARITY, `${k} sudah punya paritas`).toBe(false)
      expect(reason.length, k).toBeGreaterThan(10)
    }
  })
})

describe('HOT_PROOF: hot:true hanya untuk pembaca yang membaca env saat dipakai', () => {
  it('kunci hot CA2 = persis peta HOT_PROOF; MAX_INFLIGHT tetap boot', () => {
    expect(CA2_ENV_SPECS.filter((s) => s.restart === 'hot').map((s) => s.key).sort()).toEqual(Object.keys(HOT_PROOF).sort())
    for (const k of Object.keys(HOT_PROOF)) expect(specFor(k), k).toMatchObject({ restart: 'hot', restartRequired: false })
    // MAX_INFLIGHT dibaca sekali ke closure centralAutonomyBoot.
    expect(specFor('WEBTERM_CENTRAL_MAX_INFLIGHT')).toMatchObject({ restart: 'boot', restartRequired: true })
  })
  it.each(Object.entries(HOT_PROOF))('%s: pembaca ada dan memuat nama kunci', (key, file) => {
    const path = join(SERVER_DIR, file)
    expect(existsSync(path), file).toBe(true)
    expect(readFileSync(path, 'utf8'), `${file} memuat ${key}`).toContain(DERIVED_KEY_SOURCE[key] ?? key)
  })
  it('nama turunan READ_TOOLS memang kunci registry itu', () => {
    expect(READ_TOOLS_FLAG).toBe('WEBTERM_CENTRAL_READ_TOOLS')
  })
  it('resolver hot membaca env yang diberikan tiap panggilan (bukan salinan boot)', () => {
    expect(resolveLimits({ WEBTERM_CENTRAL_TURN_STEPS: '5' }).maxTurns).toBe(5)
    expect(resolveLimits({ WEBTERM_CENTRAL_TURN_STEPS: '7' }).maxTurns).toBe(7)
    const env: Record<string, string | undefined> = { WEBTERM_AGENT_IDLE_DONE_MS: '2000' }
    expect(idleDoneMs(env)).toBe(2000)
    env['WEBTERM_AGENT_IDLE_DONE_MS'] = '9000'
    expect(idleDoneMs(env)).toBe(9000)
    expect(budgetLimits({ WEBTERM_CENTRAL_DAILY_SPAWNS: '0' }).spawns).toBe(0) // 0 = tidak boleh spawn
    expect(contextWindowTokens({ WEBTERM_CENTRAL_CONTEXT_WINDOW: '5000' })).toBe(5000)
  })
})
