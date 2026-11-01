// Jembatan tipis antara HTTP (`IncomingMessage`/`ServerResponse`) dan router murni
// `handleControl`. Semua logika auth/route tetap di `controlApi.ts`; file ini hanya:
// menyusun `ControlDeps` nyata (sesi singleton, capability store singleton, settings dari db),
// membaca body JSON, lalu menulis hasilnya dengan bentuk respons yang sama seperti `api.ts`.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { CapabilityStore, allows, clampTtl } from './capabilities'
import { controlCwdAllowed } from './controlCwd'
import {
  declaredTooLarge,
  isParseFailure,
  parseControlBody,
  writeControlJson,
} from './controlHttpIo'
import { handleControl } from './controlApi'
import {
  CONTROL_MAX_BODY_BYTES,
  CONTROL_PREFIX,
  type ControlCapabilities,
  type ControlDeps,
  type ControlRequest,
} from './controlTypes'

/** Token kapabilitas proses ini. Diekspor supaya test/integrator bisa mem-mint langsung. */
export const capabilityStore = new CapabilityStore()

/**
 * `CapabilityStore.mint` mengembalikan string token, sedangkan kontrak `ControlCapabilities`
 * butuh `{ token, expiresAt }` untuk body route `/token`. Adapter ini menutup selisih itu tanpa
 * menyentuh `capabilities.ts`.
 */
const capabilities: ControlCapabilities = {
  verify: (token, now = Date.now()) => capabilityStore.verify(token, now),
  allows,
  mint: (options) => ({
    token: capabilityStore.mint(options),
    expiresAt: Date.now() + clampTtl(options.ttlMs),
  }),
}

let defaultDeps: Promise<ControlDeps> | undefined

/**
 * Deps produksi dimuat malas: `db`/`sessions` menyentuh `bun:sqlite` dan PTY, jadi test node-env
 * yang menyuntik deps sendiri tidak boleh memuatnya hanya karena mengimpor file ini.
 *
 * PENTING: hasilnya di-cache di level modul. Router menyimpan AckStore di WeakMap yang di-key oleh
 * objek `deps`; kalau tiap request membuat objek deps baru, jendela replay 10 menit tidak pernah
 * berlaku di produksi (B2).
 */
function resolveDefaultDeps(): Promise<ControlDeps> {
  defaultDeps ??= (async () => {
    const [{ sessions }, { db }] = await Promise.all([import('../sessions'), import('../db')])
    return {
      sessions,
      capabilities,
      settings: () => db.getSettings(),
      // Token root manusia; absen = route mint tidak ada (404), bukan 401.
      rootToken: process.env.WEBTERM_TOKEN,
      allowTokenMint: process.env.WEBTERM_ALLOW_TOKEN_MINT === '1',
      cwdAllowed: controlCwdAllowed,
    }
  })()
  return defaultDeps
}

const mergedDeps = new WeakMap<Partial<ControlDeps>, Promise<ControlDeps>>()

/**
 * Overrides test digabung SEKALI per identitas objek overrides, lalu hasil gabungannya dipakai
 * ulang. Tanpa memo ini, `{ ...default, ...overrides }` per panggilan tetap menghasilkan objek baru
 * sehingga AckStore ikut baru. Identitas berarti test yang mengubah isi objek overrides di antara
 * panggilan tidak otomatis terlihat; buat objek baru bila ingin deps baru.
 */
function depsFor(overrides?: Partial<ControlDeps>): Promise<ControlDeps> {
  if (!overrides) return resolveDefaultDeps()
  // Test yang menyuntik ketiga dep wajib tidak memicu impor `bun:sqlite`/PTY sama sekali.
  if (overrides.sessions && overrides.capabilities && overrides.settings) {
    return Promise.resolve(overrides as ControlDeps)
  }
  let merged = mergedDeps.get(overrides)
  if (!merged) {
    merged = resolveDefaultDeps().then((base) => ({ ...base, ...overrides }))
    mergedDeps.set(overrides, merged)
  }
  return merged
}

/**
 * Tangani `/api/control/*`. `true` = respons sudah ditulis; `false` = bukan milik keluarga ini
 * (atau path dikenal tapi method-nya tidak), biarkan `api.ts` melanjutkan route lain.
 * `overrides` hanya untuk test: field yang diberikan menimpa deps produksi.
 */
export async function handleControlHttp(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  readBody: () => Promise<string>,
  overrides?: Partial<ControlDeps>
): Promise<boolean> {
  const path = url.pathname
  if (path !== CONTROL_PREFIX && !path.startsWith(`${CONTROL_PREFIX}/`)) return false
  const method = (req.method || 'GET').toUpperCase()
  const withBody = method === 'POST' || method === 'PUT'

  let body: unknown
  if (withBody) {
    // Tolak sebelum membaca/menyalin body raksasa. Body yang lolos akan diperiksa lagi di bawah.
    if (declaredTooLarge(req.headers)) {
      writeControlJson(res, 413, { error: 'payload_too_large', max: CONTROL_MAX_BODY_BYTES })
      return true
    }
    const raw = await readBody()
    if (Buffer.byteLength(raw) > CONTROL_MAX_BODY_BYTES) {
      writeControlJson(res, 413, { error: 'payload_too_large', max: CONTROL_MAX_BODY_BYTES })
      return true
    }
    body = parseControlBody(raw)
    if (isParseFailure(body)) {
      writeControlJson(res, 400, { error: 'invalid_json' })
      return true
    }
  }

  const request: ControlRequest = {
    method,
    path,
    headers: req.headers,
    ...(withBody ? { body } : {}),
  }
  const deps = await depsFor(overrides)
  const result = await handleControl(request, deps)
  if (!result) return false
  writeControlJson(res, result.status, result.body)
  return true
}
