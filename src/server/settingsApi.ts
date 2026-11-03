// Rute `/api/settings`. Dipisah dari `api.ts` supaya file itu tetap satu tanggung jawab (routing
// workspace/sesi) — integrator menyambungkannya dengan satu baris di `route()`.
//
// KEAMANAN: tidak ada lapisan redaksi di sini, dan itu disengaja. Tidak satu pun kunci di
// `shared/settings.ts` bisa memuat rahasia (lihat catatan KEAMANAN di kepala file itu):
// `CustomAgent.env` hanya literal non-secret atau `${env:NAME}`, dan PUT menolak literal untuk
// kunci berpola secret. Begitu ada kunci yang bisa, ia WAJIB diredaksi di jalur GET di bawah.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Settings } from '../shared/settings'
import { readCappedRequestBody, SETTINGS_BODY_MAX_BYTES } from './cappedRequestBody'
import { createLogger } from './logs'
import { SettingsValidationError } from './settingsStore'

const log = createLogger('settings')

/** Bagian store settings yang dipakai route ini. Di-inject (bukan import singleton `db`) supaya
 *  route ini bisa diuji di node-env tanpa `bun:sqlite`; produksi meneruskan `db` dari `api.ts`. */
export type SettingsStore = {
  getSettings(): Settings
  saveSettings(patch: unknown): Settings
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

/**
 * `GET` mengembalikan snapshot penuh; `PUT` menerima PATCH parsial dan mengembalikan snapshot
 * hasil merge-nya, sehingga client yang menulis tidak perlu menebak apa yang tersimpan.
 *
 * Body `PUT` dibaca dengan cap `SETTINGS_BODY_MAX_BYTES` (lihat `cappedRequestBody.ts`): 413
 * `payload_too_large` di atas cap, 400 `body_read_failed` bila stream gagal. `POST` tetap 405 dan
 * TIDAK menyentuh stream — menambah method yang membaca body di sini akan mengubah dispatch.
 *
 * Body tidak divalidasi di sini dengan sengaja: `mergeSettings` di dalam `db.saveSettings` adalah
 * batas input tunggal (cocokkan bentuk, buang kunci tak dikenal), jadi validator kedua di sini
 * hanya akan jadi tempat kedua yang bisa tidak sepakat.
 */
export async function settingsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  store: SettingsStore
): Promise<void> {
  if (method === 'GET') return json(res, 200, store.getSettings())
  if (method === 'PUT') {
    const read = await readCappedRequestBody(req, SETTINGS_BODY_MAX_BYTES)
    if (!read.ok) {
      return read.reason === 'too_large'
        ? json(res, 413, { error: 'payload_too_large' })
        : json(res, 400, { error: 'body_read_failed' })
    }
    let patch: unknown
    try {
      patch = JSON.parse(read.body)
    } catch {
      return json(res, 400, { error: 'bad json' })
    }
    let saved: Settings
    try {
      saved = store.saveSettings(patch)
    } catch (err) {
      if (!(err instanceof SettingsValidationError)) throw err
      // Hanya {index, field, code}: tak ada nilai input yang dipantulkan balik.
      return json(res, 400, { error: 'invalid_settings', errors: err.errors })
    }
    // Nama kunci saja: nilai settings (shell, path, mode) tidak dicatat.
    const keys = patch !== null && typeof patch === 'object' ? Object.keys(patch) : []
    log.info('settings.update', 'Settings updated', { keys })
    return json(res, 200, saved)
  }
  json(res, 405, { error: 'method not allowed' })
}
