// Invarian registry gabungan (PLAN/ENV-SETTINGS-b.md 8.1): berlaku untuk SEMUA domain ter-compose.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ENV_BROWSER } from '../shared/browser.contract'
import { BOOTSTRAP_ONLY_KEYS, ENV_REGISTRY, isBootstrapOnly, specFor } from './envRegistry'
import { FILES_FLAG } from './envRegistry.files'
import { GROUP_META } from './envRegistry.groups'
import { EXPLICIT_DOMAINS, resolveMeta } from './envRegistry.meta'
import { validateEnvValue } from './envSettings.validate'

const SERVER_DIR = new URL('.', import.meta.url).pathname
const SHARED_DIR = join(SERVER_DIR, '..', 'shared')
const MAX_LABEL = 40
const MAX_DESCRIPTION = 160
const MAX_DATA_FILE_LINES = 100
const RESTARTS = ['none', 'hot', 'boot']
const AUDIENCES = ['user', 'advanced']
const LABEL_FORBIDDEN = /`/

/** Kunci tersimpan yang tak boleh hilang: override lama harus tetap dikenali (b.md 7). */
const KNOWN_KEYS_FROZEN: readonly string[] = [
  'WEBTERM_LEDGER', 'WEBTERM_TELEGRAM', 'WEBTERM_TELEGRAM_MODE', 'WEBTERM_TELEGRAM_BOT_TOKEN', 'WEBTERM_TELEGRAM_WEBHOOK_SECRET',
  'WEBTERM_CENTRAL', 'WEBTERM_CENTRAL_RUNTIME', 'WEBTERM_CENTRAL_MODEL',
  'WEBTERM_CENTRAL_MEMORY', 'WEBTERM_CENTRAL_AUTONOMY',
  'WEBTERM_ORCHESTRATOR_RUN', 'WEBTERM_RUN_REQUIRE_APPROVAL', 'WEBTERM_MEMORY_FILES', 'WEBTERM_MEMORY_DIR', 'WEBTERM_CONTROL_CWD_ROOTS',
  'WEBTERM_AGENT_SANDBOX', 'WEBTERM_TRUST_PROXY', 'WEBTERM_LOG_LEVEL', 'WEBTERM_LOG_BUFFER', 'WEBTERM_LOG_FILE',
  // ca2
  'WEBTERM_CENTRAL_AGENTS', 'WEBTERM_CENTRAL_CHECKPOINT', 'WEBTERM_CENTRAL_TURN_WALL_MS',
  'WEBTERM_CENTRAL_DAILY_TOKENS', 'WEBTERM_CENTRAL_DAILY_SPAWNS', 'WEBTERM_CENTRAL_DAILY_COST_MICROS',
  'WEBTERM_CENTRAL_SKILLS', 'WEBTERM_CENTRAL_SKILL_PROPOSE', 'WEBTERM_CENTRAL_BOTS', 'WEBTERM_CHANNEL_APPROVAL_BUTTONS', 'WEBTERM_KNOWLEDGE',
  'WEBTERM_AGENT_IDLE_DONE_MS', 'WEBTERM_CENTRAL_RELIABILITY',
  'WEBTERM_CENTRAL_MAX_INFLIGHT', 'WEBTERM_AGENT_MAIL', 'WEBTERM_CENTRAL_READ_TOOLS', 'WEBTERM_CENTRAL_CONTEXT_WINDOW', 'WEBTERM_CENTRAL_TURN_STEPS',
  // files
  'WEBTERM_FILES_MUTATE', 'WEBTERM_FILES_VIEWERS', 'WEBTERM_FILES_WATCH', 'WEBTERM_FILES_GIT_STATUS', 'WEBTERM_FILES_QUICK_OPEN', 'WEBTERM_FILES_UPLOAD',
  'WEBTERM_FILES_LIST_MAX', 'WEBTERM_FILES_UPLOAD_MAX_MB',
  // browser
  'WEBTERM_BROWSER', 'WEBTERM_BROWSER_BIN', 'WEBTERM_BROWSER_MAX_LIVE', 'WEBTERM_BROWSER_DISCARD_MS', 'WEBTERM_BROWSER_AGENT',
  'WEBTERM_BROWSER_ALLOW_HOSTS', 'WEBTERM_BROWSER_COOKIE_IMPORT', 'WEBTERM_BROWSER_COOKIE_TTL_DAYS', 'WEBTERM_BROWSER_HEADLESS', 'WEBTERM_BROWSER_CAPTURE_LINKS', 'WEBTERM_BROWSER_DOWNLOADS_AUTO',
]

/** Kunci pensiun (EM-04, L9): spec dihapus karena tanpa pembaca; override tersimpan lama tetap dipertahankan store, bukan dikenali registry. */
const RETIRED_KEYS: readonly string[] = [
  'WEBTERM_CENTRAL_TOOL_BRIDGE', 'WEBTERM_KNOWLEDGE_GRAPHIFY', 'WEBTERM_EMBED_URL', 'WEBTERM_EMBED_MODEL',
  'WEBTERM_OPENCODE_BIN', 'WEBTERM_OPENCODE_ALLOW_TOOLS', // OpenCode Central runtime removed (Claude-only)
  'WEBTERM_CENTRAL_TURN_TOKENS', // per-turn token cap was recorded but never enforced by any runtime
  // Written by capability cards but read by nothing: Telegram/Central gates use isEnabled(), proposal tools are always registered.
  'WEBTERM_CHANNELS', 'WEBTERM_CENTRAL_TELEGRAM', 'WEBTERM_CENTRAL_TOOLS', 'WEBTERM_CENTRAL_PLANNER', 'WEBTERM_CENTRAL_CHAT',
]

/** Kunci tampil tanpa pembaca literal di src/server|shared; wajib alasan tertulis. Kosong = tiap kunci punya pembaca. */
const READER_ALLOWLIST: Readonly<Record<string, string>> = {}

/** Kunci file manager dibaca lewat helper bernama (literal hanya di registry); pembacanya ditandai pemanggilan helper. */
const FILES_READER_MARKER: Readonly<Record<string, string>> = {
  [FILES_FLAG.MUTATE]: "filesFlagOn('MUTATE')", [FILES_FLAG.VIEWERS]: "filesFlagOn('VIEWERS')", [FILES_FLAG.WATCH]: "filesFlagOn('WATCH')",
  [FILES_FLAG.GIT_STATUS]: "filesFlagOn('GIT_STATUS')", [FILES_FLAG.QUICK_OPEN]: "filesFlagOn('QUICK_OPEN')", [FILES_FLAG.UPLOAD]: "filesFlagOn('UPLOAD')",
  WEBTERM_FILES_LIST_MAX: 'filesListMax(', WEBTERM_FILES_UPLOAD_MAX_MB: 'filesUploadMaxBytes(',
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

/** Kode non-test non-registry, tanpa komentar (komentar yang menyebut kunci bukan pembaca). */
function readerCorpus(): string {
  const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<![:'"`])\/\/.*$/gm, '')
  return [...walk(SERVER_DIR), ...walk(SHARED_DIR)]
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !/envRegistry[^/]*$/.test(f) && !/\.d\.ts$/.test(f))
    .map((f) => stripComments(readFileSync(f, 'utf8')))
    .join('\n')
}

/** requires.key yang tak ada di registry/bootstrap. */
function cycleFrom(key: string, path: string[] = []): string[] | null {
  if (path.includes(key)) return [...path, key]
  for (const r of specFor(key)?.requires ?? []) {
    const found = cycleFrom(r.key, [...path, key])
    if (found) return found
  }
  return null
}

describe('invarian 1-3: metadata eksplisit dan valid', () => {
  it('owner/section/audience/restart valid setelah derivasi dan group terdaftar', () => {
    for (const s of ENV_REGISTRY) {
      const m = resolveMeta(s)
      expect(m.owner.length, s.key).toBeGreaterThan(0)
      expect(m.section.length, s.key).toBeGreaterThan(0)
      expect(AUDIENCES, s.key).toContain(m.audience)
      expect(RESTARTS, s.key).toContain(m.restart)
      expect(Object.keys(GROUP_META), `${s.key} group ${s.group}`).toContain(s.group)
    }
  })

  it('tiap entri menyatakan owner, section, audience, restart eksplisit; audience user tak tergeser derivasi', () => {
    for (const s of ENV_REGISTRY) {
      expect(s.owner, `${s.key} owner`).toBeDefined()
      expect(s.section, `${s.key} section`).toBeDefined()
      expect(s.audience, `${s.key} audience`).toBeDefined()
      expect(s.restart, `${s.key} restart`).toBeDefined()
      expect(resolveMeta(s).audience, s.key).toBe(s.audience)
      expect(EXPLICIT_DOMAINS.has(resolveMeta(s).owner) || s.owner !== undefined, s.key).toBe(true)
    }
  })

  it('dangerous => dangerNote berisi; non-dangerous tanpa dangerNote', () => {
    for (const s of ENV_REGISTRY) {
      if (s.dangerous) expect((s.dangerNote ?? '').trim().length, s.key).toBeGreaterThan(0)
      else expect(s.dangerNote, s.key).toBeUndefined()
    }
  })
})

describe('invarian 4: requires', () => {
  it('tiap requires.key ada di registry atau bootstrap, bukan dirinya, tanpa siklus', () => {
    for (const s of ENV_REGISTRY) {
      for (const r of s.requires ?? []) {
        expect(specFor(r.key) !== undefined || isBootstrapOnly(r.key), `${s.key} -> ${r.key}`).toBe(true)
        expect(r.key, s.key).not.toBe(s.key)
        const target = specFor(r.key)
        if (target?.kind === 'flag') expect(r.oneOf, `${s.key} -> ${r.key}`).toBeUndefined()
        if (r.oneOf && target?.options) for (const v of r.oneOf) expect([...target.options, ''], `${s.key} -> ${r.key}`).toContain(v)
      }
      expect(cycleFrom(s.key), s.key).toBeNull()
    }
  })

  it('deteksi siklus bekerja pada graf siklik buatan', () => {
    const graph: Record<string, string[]> = { A: ['B'], B: ['C'], C: ['A'] }
    const visit = (k: string, path: string[]): boolean => path.includes(k) || (graph[k] ?? []).some((n) => visit(n, [...path, k]))
    expect(visit('A', [])).toBe(true)
    expect(visit('D', [])).toBe(false)
  })
})

describe('invarian 5: teks entri audience user', () => {
  it('label <= 40, deskripsi <= 160, tanpa backtick Markdown', () => {
    for (const s of ENV_REGISTRY) {
      expect(LABEL_FORBIDDEN.test(s.label), `${s.key} label backtick`).toBe(false)
      expect(LABEL_FORBIDDEN.test(s.description), `${s.key} description backtick`).toBe(false)
      if (s.audience === 'user') {
        expect(s.label.length, `${s.key} label`).toBeLessThanOrEqual(MAX_LABEL)
        expect(s.description.length, `${s.key} description`).toBeLessThanOrEqual(MAX_DESCRIPTION)
      }
    }
  })
})

describe('invarian 6: tiap kunci tampil punya pembaca', () => {
  const corpus = readerCorpus()
  it('literal kunci (atau helper bernama untuk file manager) muncul di kode non-test non-registry', () => {
    const missing = ENV_REGISTRY.map((s) => s.key).filter((k) => !READER_ALLOWLIST[k] && !corpus.includes(FILES_READER_MARKER[k] ?? k))
    expect(missing).toEqual([])
  })
  it('allowlist hanya berisi kunci terdaftar, beralasan, stage experimental, dan memang tanpa pembaca', () => {
    for (const [k, reason] of Object.entries(READER_ALLOWLIST)) {
      expect(specFor(k), k).toBeDefined()
      expect(specFor(k)?.stage, k).toBe('experimental')
      expect(reason.length, k).toBeGreaterThan(10)
      expect(corpus.includes(k), `${k} sudah punya pembaca: keluarkan dari allowlist`).toBe(false)
    }
  })
})

describe('invarian 7: default valid', () => {
  it('enum default ada di options atau kosong dengan effectiveDefault+allowEmpty; angka dalam rentang', () => {
    for (const s of ENV_REGISTRY) {
      if (s.kind === 'enum' && s.default === '') {
        expect(s.effectiveDefault, s.key).toBeTruthy()
        expect(s.allowEmpty, s.key).toBe(true)
      } else if (s.kind === 'enum') expect(s.options, s.key).toContain(s.default)
      if (s.kind === 'number') {
        const n = Number(s.default)
        expect(n >= (s.min as number) && n <= (s.max as number), s.key).toBe(true)
      }
      if (s.default !== undefined) expect(validateEnvValue(s, s.default).ok, s.key).toBe(true)
    }
  })
  it('optionLabels hanya memetakan opsi yang ada', () => {
    for (const s of ENV_REGISTRY) for (const o of Object.keys(s.optionLabels ?? {})) expect(s.options ?? ['on', 'off'], `${s.key}:${o}`).toContain(o)
  })
})

describe('invarian 8: kunci beku', () => {
  it('KNOWN_KEYS_FROZEN tetap ter-resolve di registry gabungan; tak ada duplikat', () => {
    expect(new Set(KNOWN_KEYS_FROZEN).size).toBe(KNOWN_KEYS_FROZEN.length)
    expect(KNOWN_KEYS_FROZEN.filter((k) => specFor(k) === undefined)).toEqual([])
    for (const k of RETIRED_KEYS) expect(specFor(k), k).toBeUndefined()
    expect(RETIRED_KEYS.filter((k) => KNOWN_KEYS_FROZEN.includes(k))).toEqual([])
    for (const k of Object.values(ENV_BROWSER)) expect(KNOWN_KEYS_FROZEN).toContain(k)
  })
  it('semua kunci registry tercantum di daftar beku (kunci baru wajib didaftarkan sadar)', () => {
    expect(ENV_REGISTRY.map((s) => s.key).filter((k) => !KNOWN_KEYS_FROZEN.includes(k))).toEqual([])
  })
  it('bootstrap-only tidak pernah ada di registry', () => {
    for (const k of BOOTSTRAP_ONLY_KEYS) expect(specFor(k), k).toBeUndefined()
    expect(BOOTSTRAP_ONLY_KEYS).toHaveLength(10)
    // Dihapus bersama token yang selalu aktif (Host allowlist tak pernah menyala lagi).
    expect(BOOTSTRAP_ONLY_KEYS).not.toContain('WEBTERM_ALLOWED_HOSTS')
    expect(BOOTSTRAP_ONLY_KEYS).toContain('WEBTERM_PROXY_PORT')
    // Dihapus (zero-config): approval kini dijaga asal UI + tolak kredensial agent, bukan flag env.
    expect(BOOTSTRAP_ONLY_KEYS).not.toContain('WEBTERM_ALLOW_LOOPBACK_APPROVAL')
    expect(specFor('WEBTERM_ALLOW_LOOPBACK_APPROVAL')).toBeUndefined()
  })
  it('kunci bootstrap yang didokumentasikan ke operator tepat 8 (L1, minus ALLOW_LOOPBACK_APPROVAL dan ALLOWED_HOSTS, plus PROXY_PORT)', () => {
    const operator = BOOTSTRAP_ONLY_KEYS.filter((k) => k !== 'WEBTERM_HOST' && k !== 'WEBTERM_TELEGRAM_API_BASE')
    expect([...operator].sort()).toEqual([
      'HOST', 'PORT', 'WEBTERM_ALLOW_TOKEN_MINT',
      'WEBTERM_DATA_DIR', 'WEBTERM_ENV_SETTINGS', 'WEBTERM_PROXY_PORT', 'WEBTERM_STRICT_HOOK_AUTH', 'WEBTERM_TOKEN',
    ])
  })
})

describe('invarian 9: berkas data registry kecil', () => {
  it('semua envRegistry.*.ts (non-test) dan browser.envRegistry.ts <= 100 baris', () => {
    const files = [...readdirSync(SERVER_DIR).filter((f) => /^envRegistry\.[\w.]+\.ts$/.test(f) && !/\.test\.ts$/.test(f)).map((f) => join(SERVER_DIR, f)), join(SERVER_DIR, 'browser', 'browser.envRegistry.ts')]
    expect(files.length).toBeGreaterThanOrEqual(8)
    for (const f of files) expect(readFileSync(f, 'utf8').split('\n').length, f).toBeLessThanOrEqual(MAX_DATA_FILE_LINES)
  })
})
