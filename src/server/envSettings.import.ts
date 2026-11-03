// Impor `.env` ke override Settings, EKSPLISIT (pratinjau + apply). Sumber HANYA `<bootCwd>/.env`
// (body tak membawa path). Tak menulis/menghapus `.env`, tak pernah otomatis di boot, dan nilai
// TIDAK PERNAH masuk respons/log/galat: `.env` bisa berisi secret.
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import type { EnvImportResult, ImportItem } from '../shared/envSettings.import.contract'
import { DOTENV_MAX_BYTES, getDotenvBoot } from './dotenvFiles'
import { isBootstrapOnly, specFor } from './envRegistry'
import type { EnvSettings } from './envSettings.service'
import { validateEnvValue } from './envSettings.validate'

export interface EnvImportDeps {
  service: EnvSettings
  /** Gerbang yang sama dengan PUT: root token terkonfigurasi. */
  rootGate(): boolean
}

export type EnvImportOutcome =
  | { status: 200; body: EnvImportResult }
  | { status: 400 | 403 | 413 | 500; body: { error: string; key?: string; reason?: string } }

type Parsed = { found: false } | { found: true; vars: NodeJS.Dict<string> } | { error: 'dotenv_too_large' | 'dotenv_unreadable' }

/** Baca `.env` boot-cwd. ENOENT = tidak ada; galat lain jadi kode statis (tanpa isi berkas). */
function readDotenv(): Parsed {
  const path = join(getDotenvBoot().cwd, '.env')
  try {
    if (statSync(path).size > DOTENV_MAX_BYTES) return { error: 'dotenv_too_large' }
    return { found: true, vars: parseEnv(readFileSync(path, 'utf8')) }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { found: false }
    return { error: 'dotenv_unreadable' }
  }
}

/**
 * Klasifikasi tiap kunci `.env`; `apply` menulis semua `add` lewat SATU `service.update`
 * (atomik + rollback secret). Kunci bootstrap tak pernah ditulis; `dangerous` butuh root.
 */
export function importDotenv(deps: EnvImportDeps, apply: boolean): EnvImportOutcome {
  const ctx = { root: deps.rootGate() }
  const state = deps.service.state(ctx)
  // Sama dengan PUT terkunci: 403 locked, tanpa efek (juga untuk dry-run).
  if (state.locked) return { status: 403, body: { error: 'locked' } }
  const parsed = readDotenv()
  if ('error' in parsed) return { status: 500, body: { error: parsed.error } }
  if (!parsed.found) return { status: 200, body: { found: false, ignored: 0, items: [] } }

  const entries = new Map(state.entries.map((e) => [e.key, e]))
  const items: ImportItem[] = []
  const toSet: Record<string, string> = {}
  let ignored = 0
  for (const [key, raw] of Object.entries(parsed.vars)) {
    if (isBootstrapOnly(key)) { items.push({ key, action: 'skip', dangerous: false, secret: false, reason: 'bootstrap' }); continue }
    const spec = specFor(key)
    const entry = entries.get(key)
    if (!spec || !entry) { ignored += 1; continue }
    const base = { key, dangerous: !!spec.dangerous, secret: spec.kind === 'secret' }
    const check = validateEnvValue(spec, raw)
    // Nilai kosong bermakna "hapus override" di PUT; impor tidak pernah menghapus.
    if (!check.ok || check.value === '') { items.push({ ...base, action: 'skip', reason: 'invalid' }); continue }
    if (base.dangerous && !ctx.root) { items.push({ ...base, action: 'skip', reason: 'needs_root' }); continue }
    if (entry.source !== 'override') { items.push({ ...base, action: 'add' }); toSet[key] = check.value; continue }
    // Nilai secret tak terbaca dari state, jadi override secret yang ada selalu `conflict` (jalur aman: tak ditimpa).
    items.push({ ...base, action: !base.secret && entry.value === check.value ? 'same' : 'conflict' })
  }
  const body: EnvImportResult = { found: true, ignored, items }
  if (!apply) return { status: 200, body }
  if (Object.keys(toSet).length === 0) return { status: 200, body: { ...body, applied: 0, restartRequired: [] } }
  const result = deps.service.update({ set: toSet, unset: [] }, ctx)
  if (!result.ok) return { status: result.status, body: { error: result.error, key: result.key, reason: result.reason } }
  return { status: 200, body: { ...body, applied: Object.keys(toSet).length, restartRequired: result.restartRequired } }
}
