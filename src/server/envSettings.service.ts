// Pengaturan env: presedensi override (Pengaturan) > env proses (.env) > default kode.
//
// Overlay MEMUTASI `target` (process.env di produksi) supaya ~20 pembaca lama dan `redactSecrets`
// tetap bekerja tanpa diubah. `base` = snapshot env SEBELUM overlay pertama, jadi "reset" (hapus
// override) mengembalikan nilai asli shell/.env, bukan nilai override terakhir. Secret hidup di
// file (envSecrets.store.ts), tak pernah di DB, dan tak pernah masuk state/log/error di bawah.
import type { EnvStateV2 } from '../shared/envSettings.contract'
import { ENV_SETTINGS_SWITCH } from './envRegistry'
import type { EnvSpec } from './envRegistry.types'
import { parseOverrides, specResolver, type OverrideStore } from './envSettings.store'
import { buildEnvState, sourceOf as sourceFrom, type StateInput } from './envSettings.state'
import { validateEnvValue } from './envSettings.validate'
import type { SecretStore } from './envSecrets.store'
import { createLogger } from './logs'

const slog = createLogger('settings')

export interface EnvChange { set: Record<string, unknown>; unset: string[] }
export interface EnvContext { /** Hanya tampilan state; mutasi digerbangi penjaga di rute, bukan di sini. */ root: boolean }

export type EnvUpdateResult =
  | { ok: true; state: EnvStateV2; restartRequired: string[] }
  | { ok: false; status: 400 | 403 | 500; error: string; key?: string; reason?: string }

export interface EnvSettings {
  /** Terapkan override + secret ke `target`; panggil saat boot dan (internal) setelah tiap update. */
  apply(): void
  state(ctx: EnvContext): EnvStateV2
  update(change: EnvChange, ctx?: EnvContext): EnvUpdateResult
}

export interface EnvSettingsDeps {
  registry: readonly EnvSpec[]
  bootstrapKeys: readonly string[]
  target: NodeJS.ProcessEnv
  overrides: OverrideStore
  secrets: SecretStore
  log?: { info(msg: string): void; warn(msg: string): void }
}

/**
 * A flag whose default is `on` is written into the env while nobody set it, so every reader (most are fail-closed
 * `flagOn`) sees the same default the Settings page shows. A value from the shell/.env or Settings still wins, and a
 * Reset (override removed) lands back on this default. `source` stays `default` (it is computed from `base`).
 */
export const defaultOnOf = (spec: EnvSpec): 'on' | undefined => (spec.kind === 'flag' && spec.default === 'on' ? 'on' : undefined)

const fail = (status: 400 | 403 | 500, error: string, key?: string, reason?: string): EnvUpdateResult =>
  ({ ok: false, status, error, ...(key ? { key } : {}), ...(reason ? { reason } : {}) })

/** Bangun layanan env-settings di atas `target`. Snapshot `base` diambil SEKARANG, sebelum overlay. */
export function createEnvSettings(deps: EnvSettingsDeps): EnvSettings {
  const { registry, target, secrets } = deps
  // Ringkasan `info` turun ke debug: kejadian per-kunci (`env.override.*`) sudah info dan memuat
  // informasi yang sama, jadi memakai level yang sama hanya menggandakan baris.
  const log = deps.log ?? { info: (m) => slog.debug('env.summary', m), warn: (m) => slog.warn('env.warn', m) }
  const specs = new Map(registry.map((s) => [s.key, s]))
  const resolve = specResolver(registry)
  const bootstrap = new Set(deps.bootstrapKeys)
  const base: Record<string, string | undefined> = {}
  for (const s of registry) base[s.key] = target[s.key]
  const locked = (target[ENV_SETTINGS_SWITCH] ?? '').trim().toLowerCase() === 'off'
  let overrides: Record<string, string> = {}
  let unknownKept: Record<string, unknown> = {}
  let fileSecrets = new Set<string>()
  let bootEnv: Record<string, string | undefined> | undefined

  const live = (): Record<string, string | undefined> => Object.fromEntries(registry.map((s) => [s.key, target[s.key]]))

  function loadOverrides(): { values: Record<string, string>; unknownKept: Record<string, unknown> } {
    try {
      return parseOverrides(deps.overrides.load(), resolve, log.warn)
    } catch (err) {
      log.warn(`env settings: cannot read stored overrides (${err instanceof Error ? err.name : 'error'}); ignoring`)
      return { values: {}, unknownKept: {} }
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
    const loaded = locked ? { values: {}, unknownKept: {} } : loadOverrides()
    overrides = loaded.values
    unknownKept = loaded.unknownKept
    fileSecrets = new Set()
    for (const spec of registry) {
      let value: string | undefined = overrides[spec.key]
      if (spec.kind === 'secret' && !locked) {
        value = loadSecret(spec)
        if (value !== undefined) fileSecrets.add(spec.key)
      }
      const next = value ?? base[spec.key] ?? defaultOnOf(spec)
      if (next === undefined) delete target[spec.key]
      else target[spec.key] = next
    }
    if (locked && bootEnv === undefined) slog.info('env.locked', 'Env settings locked: stored overrides are ignored', { switch: ENV_SETTINGS_SWITCH })
    bootEnv ??= live()
  }

  const input = (root: boolean): StateInput => ({ registry, target, base, overrides, fileSecrets, bootEnv, locked, root })
  const sourceOf = (spec: EnvSpec) => sourceFrom(spec, input(false))
  const state = (ctx: EnvContext): EnvStateV2 => buildEnvState(input(ctx.root))

  /** Cek semua kunci + nilai SEBELUM menyentuh apa pun, supaya update atomik. Nilai kosong `allowEmpty` = unset. */
  function validate(change: EnvChange): { error: EnvUpdateResult } | { values: Map<string, string>; unset: string[] } {
    const keys = [...Object.keys(change.set), ...change.unset]
    if (new Set(keys).size !== keys.length) return { error: fail(400, 'duplicate_key') }
    for (const key of keys) {
      if (bootstrap.has(key)) return { error: fail(400, 'bootstrap_only', key) }
      const spec = specs.get(key)
      if (!spec) return { error: fail(400, 'unknown_key') }
    }
    const values = new Map<string, string>()
    const unset = [...change.unset]
    for (const [key, raw] of Object.entries(change.set)) {
      const check = validateEnvValue(specs.get(key) as EnvSpec, raw)
      if (!check.ok) return { error: fail(400, 'invalid_value', key, check.reason) }
      if (check.value === '') unset.push(key)
      else values.set(key, check.value)
    }
    return { values, unset }
  }

  function persist(unset: string[], values: Map<string, string>): void {
    const undo: Array<() => void> = []
    try {
      for (const key of [...values.keys(), ...unset]) {
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
      for (const k of unset) if (plain(k)) delete next[k]
      // Kunci tak dikenal ikut ditulis balik (tak hilang saat bergantian build cabang); kunci kanonik menang.
      if (JSON.stringify(next) !== JSON.stringify(overrides)) deps.overrides.save(JSON.stringify({ ...unknownKept, ...next }))
    } catch (err) {
      for (const u of undo.reverse()) {
        try { u() } catch { log.warn('env settings: rollback of a secret write failed') }
      }
      throw err
    }
  }

  function update(change: EnvChange, ctx: EnvContext = { root: true }): EnvUpdateResult {
    if (locked) {
      slog.warn('env.locked', 'Env update rejected: settings are locked', { switch: ENV_SETTINGS_SWITCH })
      return fail(403, 'locked')
    }
    const checked = validate(change)
    if ('error' in checked) return checked.error
    const before = live()
    try {
      persist(checked.unset, checked.values)
    } catch (err) {
      log.warn(`env settings: update failed, nothing changed (${err instanceof Error ? err.message : 'error'})`)
      return fail(500, 'store_failed')
    }
    apply()
    const names = [...checked.values.keys(), ...checked.unset]
    // Nama kunci saja — nilai (terutama secret) tidak pernah dicatat.
    for (const k of checked.values.keys()) slog.info('env.override.set', 'Env override set', { name: k, source: sourceOf(specs.get(k) as EnvSpec) })
    for (const k of checked.unset) slog.info('env.override.clear', 'Env override cleared', { name: k })
    log.info(`env settings changed: ${names.map((k) => `${k}=${sourceOf(specs.get(k) as EnvSpec)}`).join(', ') || '(none)'}`)
    const restartRequired = names.filter((k) => specs.get(k)?.restartRequired && target[k] !== before[k])
    return { ok: true, state: state(ctx), restartRequired }
  }

  return { apply, state, update }
}
