// Layanan kemampuan (ES-09): tampilan murni (`viewOf`) + mutasi yang diserialkan. Satu-satunya jalur
// yang menulis kunci katalog; semua tulisan lewat `envSettings.update` (atomik), lalu `reconcile`.
import { CAPABILITIES, CAPABILITY_IDS, LINKED_SETTINGS, closure, dependents, deriveFlags, linkedSettings } from '../shared/featureCapabilities'
import type { CapabilitiesResponse, CapabilityId, CapabilityView } from '../shared/featureCapabilities'
import type { TelegramSenderFetch } from './channels/telegramSend'
import { connectTelegram, type ConnectFailure } from './channels/telegram.connect'
import { flagOr } from './envFlag'
import type { SecretStore } from './envSecrets.store'
import type { EnvSettings } from './envSettings.service'
import { advancedChange, advancedView, fieldOfKey } from './featureCapabilities.advanced'
import type { AuditEntry } from './featureCapabilities.audit'
import { rememberTelegramBot, type Detect } from './featureCapabilities.detect'
import { enabledSet, isEnabled, reconcile } from './featureCapabilities.runtime'

export { defaultDetect, type Detect } from './featureCapabilities.detect'
/** Hasil mutasi siap kirim: status HTTP + body JSON. */
export interface Reply { status: number; body: unknown }
export interface CapCtx {
  settings: EnvSettings
  /** Env yang ditulis `settings` (produksi: process.env). */
  env: NodeJS.ProcessEnv
  detect(): Detect | Promise<Detect>
  dataDir: string
  secrets: SecretStore
  fetch: TelegramSenderFetch
  /** Catat jejak; peer/via diisi pemanggil rute. */
  audit(entry: Pick<AuditEntry, 'capability' | 'action' | 'detail'>): void
}

const OWNER = { root: true }
/** Sub-switches Central reads only when it starts (ca2Boot `start`): changing one restarts Central. */
const CENTRAL_START_SUBS: ReadonlySet<string> = new Set(['WEBTERM_CENTRAL_SKILLS', 'WEBTERM_CENTRAL_SKILL_PROPOSE'])
const NEEDS_LABEL = {
  chromium: 'Choose Chrome location', telegramToken: 'Connect bot', agentEngine: 'Set up Claude Code',
} as const
const NEEDS_DETAIL = {
  chromium: 'Chrome or Chromium was not found on this computer.',
  telegramToken: 'No Telegram bot is connected yet.',
  agentEngine: 'Claude Code cannot start for Central yet. The check below shows which step fails.',
} as const
const NEEDS_STEP = { chromium: 'chromiumPath', telegramToken: 'telegramToken', agentEngine: 'agentEngine' } as const
/** Pengaturan yang ikut kartu tapi tak boleh menimpa nilai eksplisit dari shell/.env. */
const ENV_WINS = new Set(LINKED_SETTINGS.map((l) => l.key))
/** Semua kunci yang ditulis kartu untuk himpunan kemampuan `on`. */
const keysFor = (on: ReadonlySet<CapabilityId>): Record<string, string> => ({ ...deriveFlags(on), ...linkedSettings(on) })
const CONNECT_STATUS: Record<ConnectFailure, number> = {
  invalid_token_shape: 400, token_rejected: 422, unreachable: 502, save_failed: 500, enable_failed: 500,
}

/** Kunci sub-opsi untuk klien: tanpa nama env var (`WEBTERM_RUN_REQUIRE_APPROVAL` -> `runRequireApproval`). */
export const subKeyOf = (key: string): string =>
  key.replace(/^WEBTERM_/, '').toLowerCase().replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())

/** Tampilan satu kemampuan; murni terhadap `env` + `detect`. */
export function viewOf(id: CapabilityId, env: NodeJS.ProcessEnv, detect: Detect): CapabilityView {
  const def = CAPABILITIES[id]
  const base = { id, title: def.title, blurb: def.blurb }
  const met = def.needs === undefined || detect[def.needs]
  if (isEnabled(id, env)) {
    if (met) {
      const subs = def.subs?.map((s) => ({
        key: subKeyOf(s.key), label: s.label, on: flagOr(env[s.key], s.defaultOn), ...(s.dangerous ? { dangerous: true } : {}),
      }))
      const detail = id === 'telegram' && detect.telegramBot ? `Connected as ${detect.telegramBot}` : undefined
      return { ...base, status: 'on', ...(subs ? { subs } : {}), ...(detail ? { detail } : {}) }
    }
    const needs = def.needs as NonNullable<typeof def.needs>
    return { ...base, status: 'needs-step', step: { kind: NEEDS_STEP[needs], label: NEEDS_LABEL[needs] }, detail: NEEDS_DETAIL[needs] }
  }
  const missing = closure(id).filter((c) => c !== id && !isEnabled(c, env))
  const chainBroken = flagOr(env[def.primaryKey], false) && missing.length > 0
  const view: CapabilityView = chainBroken
    ? { ...base, status: 'needs-step', step: { kind: 'fixChain', label: 'Turn on what’s needed' },
        detail: `Needs ${missing.map((m) => CAPABILITIES[m].title).join(', ')}, which is still off.` }
    : { ...base, status: 'off' }
  return missing.length > 0 ? { ...view, alsoTurnsOn: missing } : view
}

/** Respons penuh: semua kemampuan urut katalog + bagian lanjutan. */
export function buildResponse(env: NodeJS.ProcessEnv, detect: Detect, dataDir: string): CapabilitiesResponse {
  return { capabilities: CAPABILITY_IDS.map((id) => viewOf(id, env, detect)), advanced: advancedView(env, dataDir) }
}
const snap = async (c: CapCtx): Promise<CapabilitiesResponse> => buildResponse(c.env, await c.detect(), c.dataDir)

// Antrean modul: dua POST bersamaan tak boleh menyisipkan reconcile satu sama lain (poller/browser ganda).
let chain: Promise<unknown> = Promise.resolve()
function exclusive<T>(job: () => Promise<T>): Promise<T> {
  const run = chain.then(job)
  chain = run.catch(() => undefined) // galat satu job tidak memblok job berikutnya
  return run
}

/** Tulis selisih `deriveFlags(prev)` -> `deriveFlags(next)` (hanya kunci berubah) lalu reconcile; galat = {status,error}. */
async function commit(c: CapCtx, prev: ReadonlySet<CapabilityId>, next: ReadonlySet<CapabilityId>): Promise<{ status: number; error: string } | undefined> {
  const [before, after] = [keysFor(prev), keysFor(next)]
  const fromEnv = new Set(c.settings.state(OWNER).entries.filter((e) => e.source === 'env').map((e) => e.key))
  const set = Object.fromEntries(Object.entries(after).filter(([k, v]) => before[k] !== v && !(ENV_WINS.has(k) && fromEnv.has(k))))
  if (Object.keys(set).length > 0) {
    const r = c.settings.update({ set, unset: [] }, OWNER)
    if (!r.ok) return { status: r.status, error: r.error }
  }
  await reconcile(prev, enabledSet(c.env))
  return undefined
}

/**
 * Boot: kemampuan yang SUDAH on (mis. Worker dinyalakan sebelum `LINKED_SETTINGS` ada) memberi nilai turunannya
 * tanpa perlu dimatikan-nyalakan. Hanya kunci yang belum diisi siapa pun (sumber `default`): env eksplisit dan
 * override yang disengaja menang. Idempoten: boot kedua tak menulis apa pun. Mengembalikan kunci yang ditulis.
 */
export function syncLinkedSettings(settings: EnvSettings, env: NodeJS.ProcessEnv): string[] {
  const [now, idle] = [linkedSettings(enabledSet(env)), linkedSettings(new Set())]
  const unset = new Set(settings.state(OWNER).entries.filter((e) => e.source === 'default').map((e) => e.key))
  const set = Object.fromEntries(Object.entries(now).filter(([k, v]) => v !== idle[k] && env[k] !== v && unset.has(k)))
  if (Object.keys(set).length === 0) return []
  const r = settings.update({ set, unset: [] }, OWNER)
  if (!r.ok) throw new Error(`sync linked capability settings failed: ${r.error}${r.key ? ` (${r.key})` : ''}`)
  return Object.keys(set)
}

/** Stop lalu start hook `id` yang sedang on, untuk memuat token/biner baru tanpa restart. */
async function bounce(c: CapCtx, id: CapabilityId): Promise<void> {
  const on = enabledSet(c.env)
  if (!on.has(id)) return
  const off = new Set(on)
  off.delete(id)
  await reconcile(on, off)
  await reconcile(off, on)
}

/** Nyalakan/matikan kemampuan beserta rantainya; respons memuat `alsoTurnsOn` untuk yang ikut menyala. */
export function toggle(c: CapCtx, id: CapabilityId, enabled: boolean): Promise<Reply> {
  return exclusive(async () => {
    const prev = enabledSet(c.env)
    const next = new Set(prev)
    if (enabled) closure(id).forEach((i) => next.add(i))
    else [id, ...dependents(id)].forEach((i) => next.delete(i))
    const failed = await commit(c, prev, next)
    if (failed) return { status: failed.status, body: { error: failed.error } }
    const changed = CAPABILITY_IDS.filter((i) => prev.has(i) !== next.has(i))
    // CA2 merakit tool worker saat Central start: Central yang tetap on perlu start ulang agar ikut berubah.
    if (prev.has('central') && next.has('central') && changed.some((i) => i === 'workers' || i === 'autonomy')) await bounce(c, 'central')
    c.audit({ capability: id, action: enabled ? 'grant' : 'revoke', detail: changed.join(',') })
    const body = await snap(c)
    const also = changed.filter((i) => i !== id && next.has(i))
    const view = body.capabilities.find((v) => v.id === id)
    if (view && enabled && also.length > 0) view.alsoTurnsOn = also
    return { status: 200, body }
  })
}

/** Ubah sub-opsi kemampuan induk; induk off = 409 `parent_off`. */
export async function setSub(c: CapCtx, id: CapabilityId, key: string, on: boolean): Promise<Reply> {
  const sub = CAPABILITIES[id].subs?.find((s) => subKeyOf(s.key) === key)
  if (!sub) return { status: 400, body: { error: 'unknown_sub' } }
  if (!isEnabled(id, c.env)) return { status: 409, body: { error: 'parent_off' } }
  const r = c.settings.update({ set: { [sub.key]: on ? 'on' : 'off' }, unset: [] }, OWNER)
  if (!r.ok) return { status: r.status, body: { error: r.error } }
  // Central reads its skill switches at start: restart it so the change applies without a server restart.
  // The checkpoint switch is re-read every turn, so it needs no restart.
  if (CENTRAL_START_SUBS.has(sub.key)) await exclusive(() => bounce(c, 'central'))
  c.audit({ capability: id, action: 'sub', detail: key })
  return { status: 200, body: await snap(c) }
}

/** Ubah mesin agen / lokasi Chrome; nilai tak valid = 400 `invalid_value` dengan nama field saja. */
export function setAdvanced(c: CapCtx, body: Record<string, unknown>): Promise<Reply> {
  return exclusive(async () => {
    const parsed = advancedChange(body)
    if ('invalid' in parsed) return { status: 400, body: { error: 'invalid_value', field: parsed.invalid } }
    const r = c.settings.update(parsed.change, OWNER)
    if (!r.ok) return { status: r.status, body: { error: r.error, ...(r.key ? { field: fieldOfKey(r.key) } : {}) } }
    // Lokasi biner baru: browser yang sudah on tapi belum menemukan Chromium harus dicoba lagi.
    if (parsed.fields.includes('chromiumPath')) await bounce(c, 'browser')
    // Jembatan Central di Telegram memilih mesin saat start: mesin baru berlaku tanpa restart server.
    if (parsed.fields.includes('agentEngine')) await bounce(c, 'telegram')
    c.audit({ capability: 'advanced', action: 'advanced', detail: parsed.fields.join(',') })
    return { status: 200, body: await snap(c) }
  })
}

/** Hapus override turunan katalog (kunci primer, turunan, sub-opsi); data pengguna dan token tidak disentuh. */
export function reset(c: CapCtx): Promise<Reply> {
  return exclusive(async () => {
    const prev = enabledSet(c.env)
    const subs = CAPABILITY_IDS.flatMap((id) => CAPABILITIES[id].subs?.map((s) => s.key) ?? [])
    const r = c.settings.update({ set: {}, unset: [...Object.keys(keysFor(new Set())), ...subs] }, OWNER)
    if (!r.ok) return { status: r.status, body: { error: r.error } }
    await reconcile(prev, enabledSet(c.env))
    c.audit({ capability: 'advanced', action: 'reset' })
    return { status: 200, body: await snap(c) }
  })
}

/** Hubungkan bot: `telegram` baru menyala SETELAH token diterima Telegram dan tersimpan. */
export async function connect(c: CapCtx, token: string): Promise<Reply> {
  const out = await connectTelegram({
    token, fetch: c.fetch, store: c.secrets,
    enable: () => exclusive(async () => {
      c.settings.apply() // token baru ada di secret store; muat ke env sebelum hook membacanya
      const prev = enabledSet(c.env)
      const failed = await commit(c, prev, new Set([...prev, ...closure('telegram')]))
      if (failed) throw new Error(`telegram enable failed: ${failed.error}`)
      if (prev.has('telegram')) await bounce(c, 'telegram') // sudah on tanpa token: hook perlu start ulang
    }),
  })
  if (!out.ok) return { status: CONNECT_STATUS[out.reason], body: { error: out.reason } }
  rememberTelegramBot(token, out.bot)
  c.audit({ capability: 'telegram', action: 'grant', detail: 'connect' })
  return { status: 200, body: { ok: true, bot: out.bot } }
}
