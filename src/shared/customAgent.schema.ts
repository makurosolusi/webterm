// Skema + validasi `CustomAgent` v2 (aditif di `app.settings` JSON, tanpa migrasi SQL).
//
// Dua mode: `load` toleran (buang entri rusak, jangan melempar, jangan menulis balik — dipakai
// `mergeSettings`), `strict` melaporkan setiap galat per field (dipakai `PUT /api/settings`).
// Field lama (`id/label/launchCmd/baseAgent/color`) hanya diperiksa tipenya saat `load`, supaya
// entri yang sudah tersimpan tetap valid persis; aturan ketat label hanya di `strict`.
//
// Hash definisi (`defHash`, sha256) dihitung di server (CA-02) atas `canonicalDefJson`: modul ini
// dipakai klien juga, jadi tidak menyentuh crypto.
import { isBuiltinAgent } from './workspace.agents'
import type { BuiltinAgentId } from './workspace.agents'

/** Cara meluncurkan agent lewat argv array (tanpa shell). Placeholder: `{prompt}`, `{sessionId}`. */
export interface CustomAgentLaunch {
  program: string
  args?: string[]
  resumeArgs?: string[]
  headlessArgs?: string[]
}

/** Agent yang didefinisikan pengguna (BYO CLI); semua field v2 opsional. */
export interface CustomAgent {
  /** Id stabil, konvensi `custom:<uuid>`. Dipakai sebagai `agentId` node. */
  id: string
  label: string
  /** Perintah peluncuran dasar (jalur PTY manusia). Kosong + `baseAgent` = pakai perintah base. */
  launchCmd: string
  /** Harness builtin opsional yang kapabilitasnya diwarisi. */
  baseAgent?: BuiltinAgentId
  /** Warna node. Kosong = warna `baseAgent`, atau abu-abu default. */
  color?: string
  /** Token ikon (bukan URL). */
  icon?: string
  launch?: CustomAgentLaunch
  /** Literal non-secret atau `${env:NAME}`; kunci berpola secret wajib `${env:NAME}`. */
  env?: Record<string, string>
  /** Izinkan central memilih agent ini (tetap R3 tiap spawn). Default false. */
  centralSpawn?: boolean
}

export interface CustomAgentError { index: number; field: string; code: string }

export const LABEL_MAX = 40
export const ARGS_MAX_COUNT = 32
export const ARG_MAX_LEN = 256
export const ENV_MAX_COUNT = 32
export const ENV_VALUE_MAX_LEN = 1024
const PROGRAM_PATH_MAX_LEN = 4096
const PLACEHOLDER_PROMPT = '{prompt}'
const PLACEHOLDER_SESSION = '{sessionId}'
const PLACEHOLDERS = new Set([PLACEHOLDER_PROMPT, PLACEHOLDER_SESSION])
const FORBIDDEN_PROGRAMS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'env', 'sudo', 'doas', 'xargs', 'eval'])
const PROGRAM_NAME_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/
const ICON_RE = /^[a-z0-9-]{1,32}$/
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/
// legacy: NODETERM_ = pre-rename prefix, still reserved; remove after 0.10.0.
const ENV_RESERVED_RE = /^(WEBTERM_|NODETERM_|wcap_)/i
const ENV_SECRET_KEY_RE = /KEY|TOKEN|SECRET|PASSWORD|AUTH/
const ENV_REF_RE = /^\$\{env:[A-Z][A-Z0-9_]{0,63}\}$/
const CONTROL_RE = /[\u0000-\u001f\u007f]/
const LINE_BREAK_RE = /[\u0000\n\r]/
const PLACEHOLDER_TOKEN_RE = /\{[^{}]*\}/g

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

/** Galat pertama (kode) untuk `launch.program`, atau null bila sah. */
function programError(p: unknown): string | null {
  if (typeof p !== 'string' || p === '') return 'required'
  const abs = p.startsWith('/')
  if (abs) {
    if (p.length > PROGRAM_PATH_MAX_LEN || LINE_BREAK_RE.test(p) || p.split('/').includes('..')) return 'bad_program'
  } else if (!PROGRAM_NAME_RE.test(p)) return 'bad_program'
  const base = (p.split('/').pop() ?? '').toLowerCase()
  return FORBIDDEN_PROGRAMS.has(base) ? 'forbidden_program' : null
}

/** Galat untuk satu daftar argv (`args`/`resumeArgs`/`headlessArgs`). */
function argvError(v: unknown): string | null {
  if (!Array.isArray(v)) return 'not_array'
  if (v.length > ARGS_MAX_COUNT) return 'too_many'
  for (const el of v) {
    if (typeof el !== 'string') return 'not_string'
    if (el.length > ARG_MAX_LEN) return 'too_long'
    if (LINE_BREAK_RE.test(el)) return 'bad_char'
    for (const tok of el.match(PLACEHOLDER_TOKEN_RE) ?? []) if (!PLACEHOLDERS.has(tok)) return 'bad_placeholder'
  }
  return null
}

const countToken = (a: string[], tok: string): number => a.filter((e) => e.includes(tok)).length

/** Aturan `launch`: tabel field -> pemeriksa, bukan if berantai. */
const LAUNCH_RULES: Array<[keyof CustomAgentLaunch, (l: Obj) => string | null]> = [
  ['program', (l) => programError(l.program)],
  ['args', (l) => (l.args === undefined ? null : argvError(l.args))],
  ['resumeArgs', (l) => {
    if (l.resumeArgs === undefined) return null
    return argvError(l.resumeArgs) ?? (countToken(l.resumeArgs as string[], PLACEHOLDER_SESSION) >= 1 ? null : 'missing_session_id')
  }],
  ['headlessArgs', (l) => {
    if (l.headlessArgs === undefined) return null
    const a = l.headlessArgs as unknown
    const bad = argvError(a)
    if (bad) return bad
    const list = a as string[]
    // Tepat satu elemen yang persis `{prompt}`, dan tidak ada kemunculan lain.
    return list.filter((e) => e === PLACEHOLDER_PROMPT).length === 1 && countToken(list, PLACEHOLDER_PROMPT) === 1
      ? null
      : 'prompt_placeholder'
  }],
]

function launchErrors(raw: unknown): Array<[string, string]> {
  if (!isObj(raw)) return [['launch', 'not_object']]
  return LAUNCH_RULES.flatMap(([field, check]) => {
    const code = check(raw)
    return code ? [[`launch.${field}`, code] as [string, string]] : []
  })
}

function envValueError(key: string, v: unknown): string | null {
  if (typeof v !== 'string') return 'not_string'
  if (ENV_REF_RE.test(v)) return null
  if (ENV_SECRET_KEY_RE.test(key)) return 'secret_literal'
  if (v.length > ENV_VALUE_MAX_LEN || LINE_BREAK_RE.test(v) || v.includes('${')) return 'bad_value'
  return null
}

function envErrors(raw: unknown): Array<[string, string]> {
  if (!isObj(raw)) return [['env', 'not_object']]
  const keys = Object.keys(raw)
  const out: Array<[string, string]> = keys.length > ENV_MAX_COUNT ? [['env', 'too_many']] : []
  for (const k of keys) {
    const code = ENV_RESERVED_RE.test(k) ? 'reserved_key' : !ENV_KEY_RE.test(k) ? 'bad_key' : envValueError(k, raw[k])
    if (code) out.push([`env.${k}`, code])
  }
  return out
}

const optString = (v: unknown, ok: (s: string) => boolean): string | null =>
  v === undefined ? null : typeof v !== 'string' ? 'not_string' : ok(v) ? null : 'bad_value'

/** Semua galat satu entri (field lama hanya dicek tipenya kecuali `strict`). */
function entryErrors(e: Obj, strict: boolean): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const add = (field: string, code: string | null): void => { if (code) out.push([field, code]) }
  add('id', typeof e.id === 'string' && e.id !== '' ? (strict && CONTROL_RE.test(e.id) ? 'bad_value' : null) : 'required')
  add('label', typeof e.label !== 'string' ? 'not_string' : strict && (e.label.length > LABEL_MAX || CONTROL_RE.test(e.label)) ? 'bad_value' : null)
  add('launchCmd', typeof e.launchCmd === 'string' ? null : 'not_string')
  add('baseAgent', e.baseAgent === undefined || (typeof e.baseAgent === 'string' && isBuiltinAgent(e.baseAgent)) ? null : 'unknown_agent')
  add('color', optString(e.color, () => true))
  add('icon', optString(e.icon, (s) => ICON_RE.test(s)))
  add('centralSpawn', e.centralSpawn === undefined || typeof e.centralSpawn === 'boolean' ? null : 'not_boolean')
  if (e.launch !== undefined) out.push(...launchErrors(e.launch))
  if (e.env !== undefined) out.push(...envErrors(e.env))
  return out
}

const KNOWN_FIELDS = ['id', 'label', 'launchCmd', 'baseAgent', 'color', 'icon', 'launch', 'env', 'centralSpawn'] as const

/** Salinan hanya dengan field dikenal (field asing tidak menumpuk di store). */
const pickKnown = (e: Obj): CustomAgent => {
  const out: Obj = {}
  for (const k of KNOWN_FIELDS) if (e[k] !== undefined) out[k] = e[k]
  return out as unknown as CustomAgent
}

/**
 * Saring `customAgents` mentah. `load`: buang elemen rusak (galatnya tetap dilaporkan untuk log),
 * tak pernah melempar. `strict`: tak ada yang dibuang, setiap galat per field dikembalikan
 * (`index` -1 = bukan array) dan pemanggil menolak tulis bila `errors` tidak kosong.
 */
export function normalizeCustomAgents(
  raw: unknown,
  mode: 'load' | 'strict'
): { agents: CustomAgent[]; errors: CustomAgentError[] } {
  const strict = mode === 'strict'
  if (!Array.isArray(raw)) {
    return { agents: [], errors: strict ? [{ index: -1, field: 'customAgents', code: 'not_array' }] : [] }
  }
  const agents: CustomAgent[] = []
  const errors: CustomAgentError[] = []
  const seen = new Set<string>()
  raw.forEach((item, index) => {
    // Load keeps an entry whose `baseAgent` is no longer a builtin (codex, gemini, … before
    // Claude-first) as a standalone CLI instead of dropping the whole agent; strict still rejects it.
    const el = !strict && isObj(item) && typeof item.baseAgent === 'string' && !isBuiltinAgent(item.baseAgent)
      ? { ...item, baseAgent: undefined }
      : item
    const found = isObj(el) ? entryErrors(el, strict) : [['', 'not_object'] as [string, string]]
    if (strict && isObj(el) && typeof el.id === 'string' && seen.has(el.id)) found.push(['id', 'duplicate'])
    if (isObj(el) && typeof el.id === 'string') seen.add(el.id)
    for (const [field, code] of found) errors.push({ index, field, code })
    if (!found.length && isObj(el)) agents.push(pickKnown(el))
  })
  return { agents, errors }
}

/** JSON kanonik definisi untuk `defHash` (urutan tetap; env: nama + rujukan/literal non-secret). */
export function canonicalDefJson(a: CustomAgent): string {
  const l = a.launch
  const env = Object.keys(a.env ?? {}).sort().map((k) => [k, (a.env as Record<string, string>)[k]])
  return JSON.stringify({
    baseAgent: a.baseAgent ?? null,
    launch: l ? [l.program, l.args ?? null, l.resumeArgs ?? null, l.headlessArgs ?? null] : null,
    env,
  })
}
