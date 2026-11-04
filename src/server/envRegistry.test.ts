// Invarian registry: unik, tidak tumpang-tindih dengan bootstrap, default lolos validator sendiri.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CA2_ENV_SPECS } from './envRegistry.ca2'
import { BOOTSTRAP_ONLY_KEYS, ENV_REGISTRY, ENV_SETTINGS_SWITCH, isBootstrapOnly, specFor } from './envRegistry'
import { setupEnv } from './envSettings.testutil'
import { validateEnvValue } from './envSettings.validate'
import type { EnvSpec } from './envRegistry.types'
import { DEFAULT_MAX_LIVE, ENV_BROWSER, MAX_LIVE_RANGE } from '../shared/browser.contract'
import { GROUP_META } from './envRegistry.groups'

const names = (f: (s: EnvSpec) => boolean): string[] => ENV_REGISTRY.filter(f).map((s) => s.key).sort()

describe('ENV_REGISTRY', () => {
  it('kunci unik dan tak ada yang bootstrap-only', () => {
    const keys = ENV_REGISTRY.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const k of keys) expect(isBootstrapOnly(k)).toBe(false)
    expect(isBootstrapOnly(ENV_SETTINGS_SWITCH)).toBe(true)
    expect(BOOTSTRAP_ONLY_KEYS).toContain('WEBTERM_TELEGRAM_API_BASE')
  })
  it('jumlah entri 64; kunci pensiun tak di state tapi override lama tetap tersimpan saat update lain', () => {
    expect(ENV_REGISTRY).toHaveLength(64)
    const retired = ['WEBTERM_CENTRAL_TOOL_BRIDGE', 'WEBTERM_KNOWLEDGE_GRAPHIFY', 'WEBTERM_EMBED_URL', 'WEBTERM_EMBED_MODEL']
    const s = setupEnv({}, JSON.stringify({ WEBTERM_CENTRAL_TOOL_BRIDGE: 'opencode', WEBTERM_EMBED_URL: 'http://x.invalid' }))
    expect(s.svc.state({ root: true }).entries.filter((e) => retired.includes(e.key))).toEqual([])
    expect(s.svc.update({ set: { WEBTERM_LEDGER: 'on' }, unset: [] }, { root: true }).ok).toBe(true)
    expect(JSON.parse(s.overrides.json as string)).toMatchObject({ WEBTERM_CENTRAL_TOOL_BRIDGE: 'opencode', WEBTERM_EMBED_URL: 'http://x.invalid', WEBTERM_LEDGER: 'on' })
  })

  it('kelas dangerous dan secret sesuai rancangan', () => {
    expect(names((s) => s.dangerous)).toEqual([
      'WEBTERM_BROWSER', 'WEBTERM_BROWSER_AGENT', 'WEBTERM_BROWSER_ALLOW_HOSTS', 'WEBTERM_BROWSER_BIN', 'WEBTERM_BROWSER_COOKIE_IMPORT',
      'WEBTERM_CENTRAL_AGENTS', 'WEBTERM_CENTRAL_AUTONOMY', 'WEBTERM_CONTROL_CWD_ROOTS', 'WEBTERM_MEMORY_DIR', 'WEBTERM_OPENCODE_ALLOW_TOOLS',
      'WEBTERM_OPENCODE_BIN', 'WEBTERM_ORCHESTRATOR_RUN', 'WEBTERM_TRUST_PROXY',
    ])
    expect(names((s) => s.kind === 'secret')).toEqual(['WEBTERM_TELEGRAM_BOT_TOKEN', 'WEBTERM_TELEGRAM_WEBHOOK_SECRET'])
    expect(specFor('WEBTERM_CHANNEL_HMAC_SECRET')).toBeUndefined() // tak ada pembaca nilainya
    expect(specFor('WEBTERM_TELEGRAM_MODE')?.default).toBe('') // otomatis (P-8); 'poll' eksplisit tersimpan tetap sah
  })

  it('env log terdaftar dengan default, bukan secret, bukan bootstrap', () => {
    expect(specFor('WEBTERM_LOG_LEVEL')).toMatchObject({ kind: 'enum', default: 'info', dangerous: false })
    expect(specFor('WEBTERM_LOG_BUFFER')).toMatchObject({ kind: 'number', default: '5000', dangerous: false })
    expect(specFor('WEBTERM_LOG_FILE')).toMatchObject({ kind: 'flag', default: 'on', dangerous: false })
    expect(validateEnvValue(specFor('WEBTERM_LOG_BUFFER') as EnvSpec, '50').ok).toBe(false)
  })

  it('default non-secret lolos validatornya sendiri', () => {
    for (const s of ENV_REGISTRY) if (s.default !== undefined) expect(validateEnvValue(s, s.default), s.key).toMatchObject({ ok: true })
  })

  it('flag CA2: semua flag/enum default off, angka dalam rentang, tanpa duplikat', () => {
    const keys = CA2_ENV_SPECS.map((s) => s.key)
    expect(keys.length).toBe(20)
    expect(new Set(keys).size).toBe(keys.length)
    for (const k of keys) expect(ENV_REGISTRY.filter((s) => s.key === k).length, k).toBe(1)
    for (const s of CA2_ENV_SPECS.filter((x) => x.kind === 'flag')) expect(s.default, s.key).toBe('off')
    expect(specFor('WEBTERM_CENTRAL_AGENTS')?.default).toBe('off')
    expect(specFor('WEBTERM_CENTRAL_DAILY_TOKENS')?.default).toBe('1000000')
    expect(specFor('WEBTERM_CENTRAL_DAILY_SPAWNS')?.default).toBe('20')
    expect(specFor('WEBTERM_CENTRAL_TURN_WALL_MS')?.default).toBe('120000')
    expect(validateEnvValue(specFor('WEBTERM_CENTRAL_AGENTS') as EnvSpec, 'bogus').ok).toBe(false)
  })
})

describe('env browser', () => {
  const browserSpecs = ENV_REGISTRY.filter((s) => s.key.startsWith('WEBTERM_BROWSER') || s.key === 'WEBTERM_BROWSER')
  it('semua kunci kontrak terdaftar di group browser dan flag default off (kecuali impor cookie & kendali agent: default on)', () => {
    expect(browserSpecs.map((s) => s.key).sort()).toEqual(Object.values(ENV_BROWSER).sort())
    for (const s of browserSpecs) {
      expect(s.group, s.key).toBe('browser')
      expect(s.restartRequired, s.key).toBe(false) // hidup-mati lewat hook kemampuan browser, tanpa restart
      expect(s.label.length, s.key).toBeGreaterThan(0)
      if (s.kind === 'flag') expect(s.default, s.key).toBe(s.key === ENV_BROWSER.cookieImport || s.key === ENV_BROWSER.agent ? 'on' : 'off')
    }
  })
  it('batas angka mengikuti kontrak', () => {
    expect(specFor(ENV_BROWSER.maxLive)).toMatchObject({ min: MAX_LIVE_RANGE.min, max: MAX_LIVE_RANGE.max, default: String(DEFAULT_MAX_LIVE) })
    expect(validateEnvValue(specFor(ENV_BROWSER.maxLive) as EnvSpec, '9').ok).toBe(false)
    expect(validateEnvValue(specFor(ENV_BROWSER.bin) as EnvSpec, 'relatif/chromium').ok).toBe(false)
  })
  it('file definisi <= 100 baris (Rule 8 config)', () => {
    expect(readFileSync(new URL('./browser/browser.envRegistry.ts', import.meta.url), 'utf8').split('\n').length).toBeLessThanOrEqual(100)
  })
})

describe('validateEnvValue number', () => {
  const spec = { key: 'X', group: 'central', kind: 'number', label: '', description: '', min: 1, max: 10, restartRequired: true, dangerous: false } as EnvSpec
  it('rentang dan bentuk', () => {
    expect(validateEnvValue(spec, '5')).toEqual({ ok: true, value: '5' })
    for (const bad of ['0', '11', 'abc', '', 'NaN', 5]) expect(validateEnvValue(spec, bad).ok).toBe(false)
  })
})

type Row = [key: string, owner: string, section: string, audience: 'user' | 'advanced', restart: 'hot' | 'boot', requires: string[]]
const L = 'WEBTERM_LEDGER'
const TG = 'WEBTERM_TELEGRAM'
const CE = 'WEBTERM_CENTRAL'
const RT = 'WEBTERM_CENTRAL_RUNTIME'
/** Tabel vonis c-ENV-02 (E01..E26): owner, section, audience, restart, key requires. */
const VERDICT: Row[] = [
  [L, 'platform', 'Basics', 'user', 'boot', []],
  ['WEBTERM_CHANNELS', 'channels', 'Telegram', 'user', 'hot', []],
  [TG, 'channels', 'Telegram', 'user', 'hot', ['WEBTERM_CHANNELS']],
  ['WEBTERM_TELEGRAM_MODE', 'channels', 'Telegram', 'user', 'boot', [TG]],
  ['WEBTERM_TELEGRAM_BOT_TOKEN', 'channels', 'Telegram', 'user', 'hot', [TG]],
  ['WEBTERM_TELEGRAM_WEBHOOK_SECRET', 'channels', 'Telegram', 'advanced', 'boot', [TG, 'WEBTERM_TELEGRAM_MODE']],
  [CE, 'central', 'Central', 'user', 'hot', []],
  ['WEBTERM_CENTRAL_CHAT', 'central', 'Central', 'user', 'hot', [CE]],
  ['WEBTERM_CENTRAL_TELEGRAM', 'channels', 'Telegram', 'user', 'hot', [TG, CE, 'WEBTERM_CENTRAL_CHAT', RT]],
  [RT, 'central', 'Central', 'user', 'hot', [CE]],
  ['WEBTERM_CENTRAL_MODEL', 'central', 'Central', 'advanced', 'hot', [RT]],
  ['WEBTERM_CENTRAL_PLANNER', 'central', 'Central', 'user', 'hot', [CE, 'WEBTERM_CENTRAL_TOOLS']],
  ['WEBTERM_CENTRAL_TOOLS', 'central', 'Central', 'user', 'hot', [CE]],
  ['WEBTERM_CENTRAL_MEMORY', 'central', 'Central', 'user', 'hot', [CE]],
  ['WEBTERM_CENTRAL_AUTONOMY', 'central', 'Central', 'user', 'hot', [CE, 'WEBTERM_ORCHESTRATOR_RUN']],
  ['WEBTERM_OPENCODE_BIN', 'central', 'Central', 'advanced', 'hot', [RT]],
  ['WEBTERM_OPENCODE_ALLOW_TOOLS', 'central', 'Central', 'advanced', 'hot', [RT]],
  ['WEBTERM_ORCHESTRATOR_RUN', 'platform', 'Orchestrator', 'user', 'hot', []],
  ['WEBTERM_RUN_REQUIRE_APPROVAL', 'platform', 'Orchestrator', 'user', 'hot', ['WEBTERM_ORCHESTRATOR_RUN']],
  ['WEBTERM_MEMORY_FILES', 'platform', 'Memory', 'user', 'hot', []],
  ['WEBTERM_MEMORY_DIR', 'platform', 'Memory', 'advanced', 'hot', ['WEBTERM_MEMORY_FILES']],
  ['WEBTERM_CONTROL_CWD_ROOTS', 'platform', 'Control', 'advanced', 'hot', []],
  ['WEBTERM_TRUST_PROXY', 'channels', 'Telegram', 'advanced', 'hot', ['WEBTERM_TELEGRAM_MODE']],
  ['WEBTERM_LOG_LEVEL', 'logs', 'Log', 'advanced', 'boot', []],
  ['WEBTERM_LOG_BUFFER', 'logs', 'Log', 'advanced', 'boot', []],
  ['WEBTERM_LOG_FILE', 'logs', 'Log', 'advanced', 'boot', []],
]

describe('vonis c-ENV-02 per entri', () => {
  it('tabel mencakup 26 kunci inti, tanpa duplikat', () => {
    expect(VERDICT).toHaveLength(26)
    expect(new Set(VERDICT.map((r) => r[0])).size).toBe(26)
  })
  it.each(VERDICT)('%s: owner/section/audience/restart/requires', (key, owner, section, audience, restart, requires) => {
    const s = specFor(key) as EnvSpec
    expect(s, key).toBeDefined()
    expect(s).toMatchObject({ owner, section, audience, restart, restartRequired: restart === 'boot' })
    expect((s.requires ?? []).map((r) => r.key)).toEqual(requires)
  })
  it('restart dikoreksi ke hot pada E05, E11, E16, E17, E19, E23', () => {
    for (const k of ['WEBTERM_TELEGRAM_BOT_TOKEN', 'WEBTERM_CENTRAL_MODEL', 'WEBTERM_OPENCODE_BIN', 'WEBTERM_OPENCODE_ALLOW_TOOLS', 'WEBTERM_RUN_REQUIRE_APPROVAL', 'WEBTERM_TRUST_PROXY', 'WEBTERM_ORCHESTRATOR_RUN']) {
      expect(specFor(k)?.restartRequired, k).toBe(false)
    }
  })
  it('grup: Telegram+central-telegram di telegram, log di logs, file di files', () => {
    expect(specFor('WEBTERM_CENTRAL_TELEGRAM')?.group).toBe('telegram')
    for (const k of ['WEBTERM_LOG_LEVEL', 'WEBTERM_LOG_BUFFER', 'WEBTERM_LOG_FILE']) expect(specFor(k)?.group, k).toBe('logs')
    for (const s of ENV_REGISTRY.filter((x) => x.key.startsWith('WEBTERM_FILES_'))) expect(s).toMatchObject({ group: 'files', owner: 'files' })
  })
  it('E01 ledger: optionLabels; E02 channels: default on, nilai asing tidak sah, ON dinormalisasi', () => {
    expect(specFor('WEBTERM_LEDGER')?.optionLabels).toEqual({ off: 'Off', shadow: 'Shadow', on: 'On' })
    expect(specFor('WEBTERM_CHANNELS')).toMatchObject({ kind: 'enum', default: 'on' })
    expect(validateEnvValue(specFor('WEBTERM_CHANNELS') as EnvSpec, 'maybe').ok).toBe(false)
    expect(validateEnvValue(specFor('WEBTERM_CHANNELS') as EnvSpec, 'ON')).toEqual({ ok: true, value: 'on' })
  })
  it('E04 mode Telegram: default kosong + effectiveDefault; kosong dan poll/webhook sah, nilai lain tidak', () => {
    const s = specFor('WEBTERM_TELEGRAM_MODE') as EnvSpec
    expect(s).toMatchObject({ default: '', allowEmpty: true })
    expect(s.effectiveDefault).toContain('poll')
    expect(s.options).toEqual(['', 'poll', 'webhook']) // opsi kosong ada di dropdown, berlabel Otomatis
    expect(s.optionLabels?.['']).toBe('Automatic')
    expect(s.description).toContain('Automatic')
    for (const v of ['', 'poll', 'webhook']) expect(validateEnvValue(s, v).ok, v).toBe(true)
    expect(validateEnvValue(s, 'push').ok).toBe(false)
  })
  it('E13 tools, E26 log file: optionLabels; E25 buffer: unit entri, rentang 100..100000', () => {
    expect(specFor('WEBTERM_CENTRAL_TOOLS')?.optionLabels).toEqual({ read: 'Read only', write: 'Can write' })
    expect(specFor('WEBTERM_LOG_FILE')?.optionLabels).toEqual({ on: 'On', off: 'Off' })
    expect(specFor('WEBTERM_LOG_BUFFER')).toMatchObject({ unit: 'entries', min: 100, max: 100000 })
  })
  it('E15, E17, E21, E22: dangerNote dan bentuk nilai', () => {
    expect(specFor('WEBTERM_CENTRAL_AUTONOMY')?.dangerNote).toContain('real workers')
    expect(specFor('WEBTERM_OPENCODE_ALLOW_TOOLS')?.dangerNote).toContain('bash/edit/webfetch/task')
    const dir = specFor('WEBTERM_MEMORY_DIR') as EnvSpec
    expect(dir).toMatchObject({ allowEmpty: true, absolutePath: true, unsetLabel: '<dataDir>/memory' })
    expect(validateEnvValue(dir, '').ok).toBe(true)
    expect(validateEnvValue(dir, 'relatif/memory').ok).toBe(false)
    expect(specFor('WEBTERM_CONTROL_CWD_ROOTS')?.description).toContain('colons')
  })
})

describe('metadata domain ca2, files, browser', () => {
  it('ca2: section Central, advanced; kunci kanal ke channels', () => {
    const moved: Record<string, [string, string]> = {
      WEBTERM_CENTRAL_BOTS: ['channels', 'Telegram'], WEBTERM_CHANNEL_APPROVAL_BUTTONS: ['channels', 'Telegram'],
    }
    for (const s of CA2_ENV_SPECS) {
      const [owner, section] = moved[s.key] ?? ['central', 'Central']
      expect(s, s.key).toMatchObject({ owner, section, audience: 'advanced' })
    }
    expect(specFor('WEBTERM_TRUST_PROXY')).toMatchObject({ owner: 'channels', section: 'Telegram', group: 'telegram' })
    expect(specFor('WEBTERM_TRUST_PROXY')?.description).toContain('webhook')
  })
  it('ca2: sub-grup Central terdaftar dengan urutan unik setelah grup central dan sebelum orkestrator', () => {
    const subs = ['central-turn', 'central-budget', 'central-context', 'central-lab']
    expect(subs.map((g) => GROUP_META[g]?.label)).toEqual(['Turn limits', 'Daily budget', 'Context & memory', 'Experiments'])
    const orders = ['central', ...subs, 'orchestrator'].map((g) => GROUP_META[g]?.order as number)
    expect([...orders].sort((a, b) => a - b)).toEqual(orders)
    expect(new Set(orders).size).toBe(orders.length)
    const groupOf = (k: string): string | undefined => specFor(k)?.group
    expect(['WEBTERM_CENTRAL_MAX_STEPS', 'WEBTERM_CENTRAL_TURN_STEPS', 'WEBTERM_CENTRAL_TURN_WALL_MS', 'WEBTERM_CENTRAL_TURN_TOKENS'].map(groupOf)).toEqual(Array(4).fill('central-turn'))
    expect(['WEBTERM_CENTRAL_DAILY_TOKENS', 'WEBTERM_CENTRAL_DAILY_SPAWNS', 'WEBTERM_CENTRAL_DAILY_COST_MICROS'].map(groupOf)).toEqual(Array(3).fill('central-budget'))
  })
  it('ca2: deskripsi jujur soal batas yang belum diberlakukan', () => {
    expect(specFor('WEBTERM_CENTRAL_TURN_TOKENS')?.description).toContain('not yet enforced')
    expect(specFor('WEBTERM_CENTRAL_DAILY_SPAWNS')?.description).toContain('0 = no spawning')
    expect(specFor('WEBTERM_LOG_LEVEL')?.description).toContain('at boot')
  })
  it('webhook secret menyebut jalur _FILE; label registry berbahasa Indonesia', () => {
    expect(specFor('WEBTERM_TELEGRAM_WEBHOOK_SECRET')?.description).toContain('WEBTERM_TELEGRAM_WEBHOOK_SECRET_FILE')
    expect(specFor('WEBTERM_MEMORY_FILES')?.label).toBe('Memory files')
    expect(specFor('WEBTERM_ORCHESTRATOR_RUN')?.label).toBe('Orchestrator run')
  })
  it('files: saklar mutasi user, sisanya advanced, semua hot', () => {
    for (const s of ENV_REGISTRY.filter((x) => x.key.startsWith('WEBTERM_FILES_'))) {
      expect(s.audience, s.key).toBe(s.key === 'WEBTERM_FILES_MUTATE' ? 'user' : 'advanced')
      expect(s.restartRequired, s.key).toBe(false)
    }
    expect(specFor('WEBTERM_FILES_LIST_MAX')?.unit).toBe('entries')
    expect(specFor('WEBTERM_FILES_UPLOAD_MAX_MB')?.unit).toBe('MB')
  })
  it('browser: saklar utama user, lainnya advanced + requires saklar utama, semua hot', () => {
    for (const k of Object.values(ENV_BROWSER)) {
      const s = specFor(k) as EnvSpec
      expect(s.restartRequired, k).toBe(false)
      expect(s.audience, k).toBe(k === ENV_BROWSER.enabled ? 'user' : 'advanced')
      expect((s.requires ?? []).map((r) => r.key), k).toEqual(k === ENV_BROWSER.enabled ? [] : [ENV_BROWSER.enabled])
    }
  })
})
