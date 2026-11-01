// Jembatan tipis antara HTTP (`IncomingMessage`/`ServerResponse`) dan router murni
// `handleControl`. Semua logika auth/route tetap di `controlApi.ts`; file ini hanya:
// menyusun `ControlDeps` nyata (sesi singleton, capability store singleton, settings dari db),
// membaca body JSON, lalu menulis hasilnya dengan bentuk respons yang sama seperti `api.ts`.

import type { IncomingMessage, ServerResponse } from 'node:http'
import npath from 'node:path'
import { CapabilityStore, allows, clampTtl } from './capabilities'
import { handleControl } from './controlApi'
import { CONTROL_PREFIX, type ControlCapabilities, type ControlDeps, type ControlRequest } from './controlTypes'

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
      // P1 masih permisif; P1b mempersempit ke workspace root.
      cwdAllowed: (cwd) => npath.isAbsolute(cwd),
    }
  })()
  return defaultDeps
}

/** Body hanya untuk method yang memang punya body; JSON rusak diperlakukan sebagai `{}`. */
function parseBody(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return {}
  }
}

function json(res: ServerResponse, status: number, body?: unknown): void {
  res.statusCode = status
  if (body === undefined) { res.end(); return }
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
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
  const request: ControlRequest = {
    method,
    path,
    headers: req.headers,
    ...(withBody ? { body: parseBody(await readBody()) } : {}),
  }

  // Test yang menyuntik ketiga dep wajib tidak memicu impor `bun:sqlite`/PTY sama sekali.
  const injected = overrides?.sessions && overrides.capabilities && overrides.settings
  const deps: ControlDeps = injected
    ? (overrides as ControlDeps)
    : { ...(await resolveDefaultDeps()), ...overrides }
  const result = await handleControl(request, deps)
  if (!result) return false
  json(res, result.status, result.body)
  return true
}
