// Logika settings sisi server, TANPA menyentuh SQLite — supaya bisa dites di node-env (vitest)
// sementara `db.ts` yang mengimpor `bun:sqlite` tetap Bun-only. `Db.getSettings()` /
// `Db.saveSettings()` adalah pembungkus tipis di atas fungsi di sini.
//
// SENGAJA TIDAK DIPORT dari nodeterm `src/core/settings-store.ts`:
//  - Rantai tulis atomik (`writeFileAtomic` temp+rename, mode 0600) dan `saveChain` FIFO. Keduanya
//    menjawab masalah yang tidak ada di sini: satu `INSERT … ON CONFLICT` SQLite sudah satu
//    transaksi (tak ada state setengah-tertulis), dan `bun:sqlite` sinkron — jadi siklus
//    baca→merge→tulis di `saveSettings` berjalan utuh dalam satu turn event-loop dan tidak bisa
//    diselang request lain. Yang dicegah `saveChain` nodeterm (rename terakhir vs call terakhir
//    saling tidak sepakat) secara struktural tidak bisa terjadi.
//  - 7 migrasi load-time (seed dictation, flip `openMarkdownPreview`, `terminalGpuRendering`
//    boolean→enum, `agentLaunchMode`, `newProjectStorage`, `runInBackgroundOnClose`,
//    `glassTerminals`). Semuanya membaca kunci warisan dari `settings.json` versi lama; webterm
//    belum pernah merilis settings tersimpan, jadi tidak ada satu pun file yang bisa memicunya.

import { normalizeCustomAgents, type CustomAgentError } from '../shared/customAgent.schema'
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from '../shared/settings'
import { applySettingsPatch } from '../shared/settings.patch'
import { projectModelsPatchErrors } from '../shared/settings.projectModels'
import { inputHistoryPatchErrors } from '../shared/settings.inputHistory'
import { DEFAULT_CLAUDE_PROFILE, seedClaudeProfiles, type ClaudeLaunchSettings } from '../shared/claudeLaunch/claudeLaunch.profiles'
import { setCustomAgentBaseResolver, type AgentId, type BuiltinAgentId } from '../shared/workspace'
import { createLogger } from './logs'

const log = createLogger('settings')
/** Key of the settings row in the `app` table (see `db.ts`). */
const SETTINGS_ROW_KEY = 'settings'

/** Galat validasi `PUT /api/settings` per field; rute memetakannya ke HTTP 400. */
export class SettingsValidationError extends Error {
  constructor(readonly errors: CustomAgentError[]) {
    super(`invalid settings: ${errors.length} error(s)`)
    this.name = 'SettingsValidationError'
  }
}

/** Peringatan tanpa isi (hanya jumlah + nama field skema): entri rusak dibuang saat load. */
function warnDropped(errors: CustomAgentError[]): void {
  log.warn('settings.customAgents.dropped', 'Dropped invalid custom agents on load', {
    count: new Set(errors.map((e) => e.index)).size,
    fields: [...new Set(errors.map((e) => e.field.replace(/^env\..*/, 'env.*')))],
  })
}

/** Baca baris `app.settings`. JSON rusak / baris absen jatuh ke default, tidak melempar: settings
 *  tidak boleh menjadi alasan server gagal start. */
export function parseStored(json: string | null): Settings {
  // mergeSettings({}) equals mergeSettings(null) (pinned by a test), so a corrupt row gets defaults.
  return json ? mergeSettings(storedDocument(json), warnDropped) : mergeSettings(null)
}

/** The last corrupt row value already warned about: getSettings runs on every GET, so one
 *  unreadable row logs once, not once per request. Kept in memory only, never logged. */
let warnedCorruptRow: string | null = null

/** Stored row -> raw document. Absent or corrupt -> {} (reads then fall back to defaults). */
function storedDocument(json: string | null): Record<string, unknown> {
  if (!json) return {}
  try {
    return asRecord(JSON.parse(json))
  } catch (err) {
    if (json === warnedCorruptRow) return {}
    warnedCorruptRow = json
    // The next patch rewrites the unreadable row from {}: leave a trace (message only, never content).
    log.warn('settings.read.corrupt', 'Stored settings row is not valid JSON; using an empty document', {
      operation: 'settings read',
      key: SETTINGS_ROW_KEY,
      cause: err instanceof Error ? err.message : String(err),
    })
    return {}
  }
}

/** A patched value is written only when it is a known key with the default's basic shape. */
function acceptsShape(key: string, v: unknown): boolean {
  if (!(key in DEFAULT_SETTINGS) || v === null || v === undefined) return false
  const d = DEFAULT_SETTINGS[key as keyof Settings]
  return typeof v === typeof d && Array.isArray(v) === Array.isArray(d)
}

/**
 * The next stored document and its normalized view. The RAW stored document is the source of
 * truth: only the patched keys are validated and written (in normalized form), every other stored
 * key stays as it was, including keys this build does not know and entries that fail today's
 * validation (a rollback or a newer build must not lose them). Reference: VS Code keeps unknown
 * settings in settings.json untouched. Unknown or wrong-shaped PATCH keys are dropped, so the
 * HTTP input cannot add junk. Entry keys (`settings.patch.ts`) merge one entry, `null` deletes.
 * `patch.customAgents` is validated `strict` and THROWS `SettingsValidationError`, so a broken PUT
 * is refused (400) instead of silently dropped; so is a `patch.projectModels` entry with an unknown model/effort
 * and a `patch.inputHistory` list not in stored form.
 */
export function nextSettingsDocument(storedJson: string | null, patch: unknown): { doc: Record<string, unknown>; settings: Settings } {
  const p = asRecord(patch)
  if (Array.isArray(p.customAgents)) {
    const { errors } = normalizeCustomAgents(p.customAgents, 'strict')
    if (errors.length) throw new SettingsValidationError(errors)
  }
  const modelErrors = projectModelsPatchErrors(p.projectModels)
  if (modelErrors.length) throw new SettingsValidationError(modelErrors)
  const historyErrors = inputHistoryPatchErrors(p.inputHistory)
  if (historyErrors.length) throw new SettingsValidationError(historyErrors)
  const accepted = Object.fromEntries(Object.entries(p).filter(([k, v]) => acceptsShape(k, v)))
  const stored = storedDocument(storedJson)
  const doc = applySettingsPatch(stored, accepted)
  let settings = mergeSettings(doc, warnDropped)
  for (const k of Object.keys(accepted)) doc[k] = settings[k as keyof Settings]
  const pointers = droppedProfilePointers(mergeSettings(stored), settings)
  if (Object.keys(pointers).length) {
    Object.assign(doc, pointers)
    settings = { ...settings, ...pointers }
  }
  // The one-time load migration (legacy claude command -> profile) is persisted with the write.
  Object.assign(doc, seedClaudeProfiles(doc, settings.agentLaunchCommands.claude))
  return { doc, settings }
}

/**
 * Every writer (the profiles card, the provider card, any PUT): a write that removes the profile the
 * default or Central points at moves that pointer to where launches fall back (Default / '' = follow the
 * default), like the profiles card does. Only a removal in THIS write: an already-dangling default (old data)
 * is left alone, the launcher reads it as Default (`claudeLauncher.effective`), so its nodes keep launching silently.
 */
function droppedProfilePointers(prev: Settings, next: Settings): Partial<ClaudeLaunchSettings> {
  const removed = (id: string): boolean =>
    prev.claudeLaunchProfiles.some((p) => p.id === id) && !next.claudeLaunchProfiles.some((p) => p.id === id)
  return {
    ...(removed(next.defaultClaudeProfileId) ? { defaultClaudeProfileId: DEFAULT_CLAUDE_PROFILE.id } : {}),
    ...(removed(next.centralClaudeProfileId) ? { centralClaudeProfileId: '' } : {}),
  }
}

/** The normalized snapshot after `patch` (see `nextSettingsDocument`). */
export function nextSettings(storedJson: string | null, patch: unknown): Settings {
  return nextSettingsDocument(storedJson, patch).settings
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/**
 * Daftarkan lookup `custom:<uuid>` → `baseAgent` yang dibutuhkan `capabilityAgentId` di
 * `shared/workspace.ts`. Tanpa ini agent custom tidak mewarisi kapabilitas harness apa pun di sisi
 * server (resume, context link, mint session id) — lihat catatan BaseResolver di modul itu.
 *
 * `read` dipanggil tiap resolve, bukan sekali: settings bisa berubah saat runtime lewat
 * `PUT /api/settings` dan resolver harus melihat daftar terbaru.
 */
export function registerAgentBaseResolver(read: () => Settings): void {
  setCustomAgentBaseResolver((id: AgentId): BuiltinAgentId | undefined => {
    for (const a of read().customAgents) if (a.id === id) return a.baseAgent
    return undefined
  })
}
