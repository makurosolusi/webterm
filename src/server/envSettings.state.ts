// Pembangun state env v2 (GET /api/settings/env): nilai ternormalisasi, validitas, nilai efektif.
// Murni (tanpa I/O). Secret tidak pernah membawa nilai; token root hanya jadi boolean.
import type { EnvEntryV2, EnvGroupMeta, EnvSourceV2, EnvStateV2 } from '../shared/envSettings.contract'
import { groupMetaFor } from './envRegistry.groups'
import { resolveMeta } from './envRegistry.meta'
import type { EnvKind, EnvSpec } from './envRegistry.types'
import { validateEnvValue } from './envSettings.validate'

/** Batas panjang `rawValue` yang dikirim ke klien. */
export const RAW_VALUE_MAX_CHARS = 40
const TOKEN_KEY = 'WEBTERM_TOKEN'

/** Snapshot yang dibutuhkan untuk membangun state; semua diisi layanan. */
export interface StateInput {
  registry: readonly EnvSpec[]
  target: NodeJS.ProcessEnv
  /** Env sebelum overlay pertama (nilai asli shell/.env). */
  base: Readonly<Record<string, string | undefined>>
  overrides: Readonly<Record<string, string>>
  fileSecrets: ReadonlySet<string>
  /** Env saat boot; undefined sebelum apply() pertama. */
  bootEnv: Readonly<Record<string, string | undefined>> | undefined
  locked: boolean
  /** Request lolos gerbang root token. */
  root: boolean
}

const REASON: Record<EnvKind, string> = {
  flag: 'Bukan on/off; dibaca sebagai off.',
  enum: 'Bukan salah satu opsi; dibaca sebagai bawaan.',
  number: 'Bukan angka dalam rentang yang diizinkan.',
  string: 'Nilai tidak sah.',
  secret: 'Bentuk nilai tidak sah.',
}
const REASON_ABSOLUTE = 'Harus path absolut.'

const nonEmpty = (v: string | undefined): v is string => v !== undefined && v.trim() !== ''

/** Dari mana nilai spec ini berasal. */
export function sourceOf(spec: EnvSpec, i: Pick<StateInput, 'fileSecrets' | 'overrides' | 'base'>): EnvSourceV2 {
  if (spec.kind === 'secret' ? i.fileSecrets.has(spec.key) : i.overrides[spec.key] !== undefined) return 'override'
  return nonEmpty(i.base[spec.key]) ? 'env' : 'default'
}

interface View { value: string; valid: boolean; invalidReason?: string; rawValue?: string }

/** Nilai mentah -> nilai kanonik; kosong = default. Nilai tak sah dilaporkan, tidak dipura-purakan. */
function view(spec: EnvSpec, raw: string | undefined): View {
  const t = (raw ?? '').trim()
  const fallback = spec.default ?? ''
  if (t === '') return { value: fallback, valid: true }
  const lower = t.toLowerCase()
  if (spec.kind === 'flag' && (lower === 'on' || lower === 'off')) return { value: lower, valid: true }
  const check = spec.kind === 'flag' ? undefined : validateEnvValue(spec, t)
  if (check?.ok) return { value: check.value, valid: true }
  const invalidReason = spec.kind === 'string' && spec.absolutePath ? REASON_ABSOLUTE : REASON[spec.kind]
  const value = spec.kind === 'flag' ? 'off' : spec.kind === 'enum' ? fallback : t
  return { value, valid: false, invalidReason, rawValue: t.slice(0, RAW_VALUE_MAX_CHARS) }
}

function entryOf(spec: EnvSpec, i: StateInput): EnvEntryV2 {
  const m = resolveMeta(spec)
  const source = sourceOf(spec, i)
  const boot = m.restart === 'boot'
  const common = {
    key: spec.key, kind: spec.kind, group: spec.group, label: spec.label, description: spec.description, source,
    restartRequired: boot, pendingRestart: boot && i.target[spec.key] !== i.bootEnv?.[spec.key],
    dangerous: spec.dangerous, editable: !i.locked && (!spec.dangerous || i.root),
    owner: m.owner, section: m.section, audience: m.audience, requires: m.requires, restart: m.restart,
    effectiveDefault: m.effectiveDefault, stage: m.stage, dangerNote: spec.dangerNote,
  }
  if (spec.kind === 'secret') {
    const set = source !== 'default'
    return { ...common, value: '', effective: '', valid: true, set, secretSet: set }
  }
  const stored = source === 'override' ? i.overrides[spec.key] : source === 'env' ? i.base[spec.key] : undefined
  const shown = view(spec, stored)
  return {
    ...common, ...shown, default: spec.default, options: spec.options && [...spec.options],
    optionLabels: spec.optionLabels, min: spec.min, max: spec.max, unit: spec.unit, unsetLabel: spec.unsetLabel,
    allowEmpty: spec.allowEmpty, absolutePath: spec.absolutePath,
    effective: view(spec, (boot ? i.bootEnv ?? i.target : i.target)[spec.key]).value,
  }
}

/** State env v2. Kunci bootstrap tidak masuk `entries`; hanya `server.tokenSet` (boolean). */
export function buildEnvState(i: StateInput): EnvStateV2 {
  const groups = new Map<string, EnvGroupMeta>()
  for (const s of i.registry) groups.set(s.group, groupMetaFor(s.group))
  return {
    locked: i.locked,
    rootGate: i.root,
    server: { tokenSet: nonEmpty(i.target[TOKEN_KEY]), settingsLocked: i.locked },
    groups: [...groups.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
    entries: i.registry.map((s) => entryOf(s, i)),
  }
}
