// Pengaturan env: presedensi override (Pengaturan) > env proses (.env) > default kode.
//
// Overlay MEMUTASI `target` (process.env di produksi) supaya ~20 pembaca lama dan `redactSecrets`
// tetap bekerja tanpa diubah. `base` = snapshot env SEBELUM overlay pertama, jadi "reset" (hapus
// override) mengembalikan nilai asli shell/.env, bukan nilai override terakhir. Secret hidup di
// file (envSecrets.store.ts), tak pernah di DB, dan tak pernah masuk state/log/error di bawah.
import { ENV_SETTINGS_SWITCH } from './envRegistry'
import type { EnvGroup, EnvKind, EnvSpec } from './envRegistry.types'
import { parseOverrides, type OverrideStore } from './envSettings.store'
import { validateEnvValue } from './envSettings.validate'
import type { SecretStore } from './envSecrets.store'
import { createLogger } from './logs'

const slog = createLogger('settings')

export type EnvSource = 'override' | 'env' | 'default'

export interface EnvEntry {
  key: string
  group: EnvGroup
  kind: EnvKind
  label: string
  description: string
  default?: string
  options?: readonly string[]
  source: EnvSource
  /** Hanya non-secret yang bisa diedit. */
  value?: string
  /** Hanya secret / kunci bootstrap: terisi atau tidak. Tak pernah nilai, panjang, atau prefix. */
  set?: boolean
  restartRequired: boolean
  /** Nilai efektif berbeda dari saat boot dan kunci ini butuh restart. */
  pendingRestart: boolean
  dangerous: boolean
  editable: boolean
}

export interface EnvState { locked: boolean; entries: EnvEntry[] }
export interface EnvChange { set: Record<string, unknown>; unset: string[] }
export interface EnvContext { /** Request lolos gerbang root token (token terkonfigurasi). */ root: boolean }

export type EnvUpdateResult =
  | { ok: true; state: EnvState; restartRequired: string[] }
  | { ok: false; status: 400 | 403 | 500; error: string; key?: string; reason?: string }

export interface EnvSettings {
  /** Terapkan override + secret ke `target`; panggil saat boot dan (internal) setelah tiap update. */
  apply(): void
  state(ctx: EnvContext): EnvState
  update(change: EnvChange, ctx: EnvContext): EnvUpdateResult
}

export interface EnvSettingsDeps {
  registry: readonly EnvSpec[]
  bootstrapKeys: readonly string[]
  target: NodeJS.ProcessEnv
  overrides: OverrideStore
  secrets: SecretStore
  log?: { info(msg: string): void; warn(msg: string): void }
}

const BOOTSTRAP_DESCRIPTION = 'Hanya lewat env; tidak bisa diubah dari Pengaturan.'

const fail = (status: 400 | 403 | 500, error: string, key?: string, reason?: string): EnvUpdateResult =>
  ({ ok: false, status, error, ...(key ? { key } : {}), ...(reason ? { reason } : {}) })

const nonEmpty = (v: string | undefined): v is string => v !== undefined && v.trim() !== ''

/** Bangun layanan env-settings di atas `target`. Snapshot `base` diambil SEKARANG, sebelum overlay. */
export function createEnvSettings(deps: EnvSettingsDeps): EnvSettings {
  const { registry, target, secrets } = deps
  // Ringkasan `info` turun ke debug: kejadian per-kunci (`env.override.*`) sudah info dan memuat
  // informasi yang sama, jadi memakai level yang sama hanya menggandakan baris.
  const log = deps.log ?? { info: (m) => slog.debug('env.summary', m), warn: (m) => slog.warn('env.warn', m) }
  const specs = new Map(registry.map((s) => [s.key, s]))
  const bootstrap = new Set(deps.bootstrapKeys)
  const base: Record<string, string | undefined> = {}
  for (const s of registry) base[s.key] = target[s.key]
  const locked = (target[ENV_SETTINGS_SWITCH] ?? '').trim().toLowerCase() === 'off'
  let overrides: Record<string, string> = {}
  let fileSecrets = new Set<string>()
  let bootEnv: Record<string, string | undefined> | undefined

  const live = (): Record<string, string | undefined> => Object.fromEntries(registry.map((s) => [s.key, target[s.key]]))

  function loadOverrides(): Record<string, string> {
    try {
      return parseOverrides(deps.overrides.load(), (k) => specs.get(k), log.warn)
    } catch (err) {
      log.warn(`env settings: cannot read stored overrides (${err instanceof Error ? err.name : 'error'}); ignoring`)
      return {}
    }
  }

  function loadSecret(spec: EnvSpec): string | undefined {
    const raw = secrets.read(spec.key)
    if (raw === null) return undefined
    if (validateEnvValue(spec, raw).ok) return raw
    log.warn(`env settings: ignoring stored secret with unexpected shape for ${spec.key}`)
    return undefined
  }

  function apply(): void {
    overrides = locked ? {} : loadOverrides()
    fileSecrets = new Set()
    for (const spec of registry) {
      let value: string | undefined = overrides[spec.key]
      if (spec.kind === 'secret' && !locked) {
        value = loadSecret(spec)
        if (value !== undefined) fileSecrets.add(spec.key)
      }
      const next = value ?? base[spec.key]
      if (next === undefined) delete target[spec.key]
      else target[spec.key] = next
    }
    if (locked && bootEnv === undefined) slog.info('env.locked', 'Env settings locked: stored overrides are ignored', { switch: ENV_SETTINGS_SWITCH })
    bootEnv ??= live()
  }

  function sourceOf(spec: EnvSpec): EnvSource {
    if (spec.kind === 'secret' ? fileSecrets.has(spec.key) : overrides[spec.key] !== undefined) return 'override'
    return nonEmpty(base[spec.key]) ? 'env' : 'default'
  }

  function entryOf(spec: EnvSpec, root: boolean): EnvEntry {
    const source = sourceOf(spec)
    const common = {
      key: spec.key, group: spec.group, kind: spec.kind, label: spec.label, description: spec.description,
      source, restartRequired: spec.restartRequired, dangerous: spec.dangerous,
      pendingRestart: spec.restartRequired && target[spec.key] !== bootEnv?.[spec.key],
      editable: !locked && (!spec.dangerous || root),
    }
    if (spec.kind === 'secret') return { ...common, set: source !== 'default' }
    const value = source === 'override' ? overrides[spec.key] : source === 'env' ? base[spec.key]?.trim() : spec.default
    return { ...common, default: spec.default, options: spec.options, ...(value === undefined ? {} : { value }) }
  }

  function bootstrapEntry(key: string): EnvEntry {
    const set = nonEmpty(target[key])
    return {
      key, group: 'bootstrap', kind: 'string', label: key, description: BOOTSTRAP_DESCRIPTION,
      source: set ? 'env' : 'default', set, restartRequired: true, pendingRestart: false, dangerous: false, editable: false,
    }
  }

  function state(ctx: EnvContext): EnvState {
    return { locked, entries: [...registry.map((s) => entryOf(s, ctx.root)), ...deps.bootstrapKeys.map(bootstrapEntry)] }
  }

  /** Cek semua kunci + nilai SEBELUM menyentuh apa pun, supaya update atomik. */
  function validate(change: EnvChange, ctx: EnvContext): { error: EnvUpdateResult } | { values: Map<string, string> } {
    const keys = [...Object.keys(change.set), ...change.unset]
    if (new Set(keys).size !== keys.length) return { error: fail(400, 'duplicate_key') }
    for (const key of keys) {
      if (bootstrap.has(key)) return { error: fail(400, 'bootstrap_only', key) }
      const spec = specs.get(key)
      if (!spec) return { error: fail(400, 'unknown_key') }
      if (spec.dangerous && !ctx.root) return { error: fail(403, 'token_required', key) }
    }
    const values = new Map<string, string>()
    for (const [key, raw] of Object.entries(change.set)) {
      const check = validateEnvValue(specs.get(key) as EnvSpec, raw)
      if (!check.ok) return { error: fail(400, 'invalid_value', key, check.reason) }
      values.set(key, check.value)
    }
    return { values }
  }

  function persist(change: EnvChange, values: Map<string, string>): void {
    const undo: Array<() => void> = []
    try {
      for (const key of [...values.keys(), ...change.unset]) {
        if (specs.get(key)?.kind !== 'secret') continue
        const prev = secrets.read(key)
        const value = values.get(key)
        if (value === undefined) secrets.remove(key)
        else secrets.write(key, value)
        undo.push(() => (prev === null ? secrets.remove(key) : secrets.write(key, prev)))
      }
      const plain = (k: string): boolean => specs.get(k)?.kind !== 'secret'
      const next = { ...overrides }
      for (const [k, v] of values) if (plain(k)) next[k] = v
      for (const k of change.unset) if (plain(k)) delete next[k]
      if (JSON.stringify(next) !== JSON.stringify(overrides)) deps.overrides.save(JSON.stringify(next))
    } catch (err) {
      for (const u of undo.reverse()) {
        try { u() } catch { log.warn('env settings: rollback of a secret write failed') }
      }
      throw err
    }
  }

  function update(change: EnvChange, ctx: EnvContext): EnvUpdateResult {
    if (locked) {
      slog.warn('env.locked', 'Env update rejected: settings are locked', { switch: ENV_SETTINGS_SWITCH })
      return fail(403, 'locked')
    }
    const checked = validate(change, ctx)
    if ('error' in checked) return checked.error
    const before = live()
    try {
      persist(change, checked.values)
    } catch (err) {
      log.warn(`env settings: update failed, nothing changed (${err instanceof Error ? err.message : 'error'})`)
      return fail(500, 'store_failed')
    }
    apply()
    const names = [...checked.values.keys(), ...change.unset]
    // Nama kunci saja — nilai (terutama secret) tidak pernah dicatat.
    for (const k of checked.values.keys()) slog.info('env.override.set', 'Env override set', { name: k, source: sourceOf(specs.get(k) as EnvSpec) })
    for (const k of change.unset) slog.info('env.override.clear', 'Env override cleared', { name: k })
    log.info(`env settings changed: ${names.map((k) => `${k}=${sourceOf(specs.get(k) as EnvSpec)}`).join(', ') || '(none)'}`)
    const restartRequired = names.filter((k) => specs.get(k)?.restartRequired && target[k] !== before[k])
    return { ok: true, state: state(ctx), restartRequired }
  }

  return { apply, state, update }
}
