// Bagian "Lanjutan" kemampuan (ES-09): mesin agen + lokasi Chrome. Respons memakai NAMA FIELD
// (`agentEngine`, `chromiumPath`), tak pernah nama env var, supaya UI tak membocorkan istilah konfigurasi.
import type { CapabilitiesResponse } from '../shared/featureCapabilities'
import { ENV_BROWSER } from '../shared/browser.contract'
import { detectChromium } from './browser/chromium.launch'
import { detectAgentEngine } from './central/runtime/runtimeDetect'
import { CENTRAL_RUNTIME_FLAG } from './central/runtime/runtimeFlag'
import type { EnvChange } from './envSettings.service'

/** Mesin yang boleh dipilih eksplisit; `auto` = hapus override. */
const ENGINES = ['claude', 'opencode', 'mock'] as const
const AUTO = 'auto'
/** Batas panjang path agar body tak membengkak; validasi isi tetap oleh registry. */
const PATH_MAX_CHARS = 1024

/** Isi `advanced` untuk GET: nilai terpilih + hasil deteksi (tanpa mengikuti pilihan eksplisit). */
export function advancedView(env: NodeJS.ProcessEnv, dataDir: string): CapabilitiesResponse['advanced'] {
  const chosen = (env[CENTRAL_RUNTIME_FLAG] ?? '').trim().toLowerCase()
  return {
    agentEngine: {
      value: ENGINES.find((e) => e === chosen) ?? AUTO,
      detected: detectAgentEngine({ ...env, [CENTRAL_RUNTIME_FLAG]: undefined }),
    },
    chromiumPath: { value: env[ENV_BROWSER.bin] ?? '', detected: detectChromium(env) !== null },
    dataDir,
  }
}

export type AdvancedParse = { change: EnvChange; fields: string[] } | { invalid: string }

/** Ubah body PUT jadi perubahan env; field salah tipe/nilai = `{ invalid: namaField }`. */
export function advancedChange(body: Record<string, unknown>): AdvancedParse {
  const change: EnvChange = { set: {}, unset: [] }
  const fields: string[] = []
  const { agentEngine, chromiumPath } = body
  if (agentEngine !== undefined) {
    if (agentEngine !== AUTO && !ENGINES.some((e) => e === agentEngine)) return { invalid: 'agentEngine' }
    if (agentEngine === AUTO) change.unset.push(CENTRAL_RUNTIME_FLAG)
    else change.set[CENTRAL_RUNTIME_FLAG] = agentEngine
    fields.push('agentEngine')
  }
  if (chromiumPath !== undefined) {
    if (typeof chromiumPath !== 'string' || chromiumPath.length > PATH_MAX_CHARS) return { invalid: 'chromiumPath' }
    if (chromiumPath.trim() === '') change.unset.push(ENV_BROWSER.bin)
    else change.set[ENV_BROWSER.bin] = chromiumPath.trim()
    fields.push('chromiumPath')
  }
  return { change, fields }
}

/** Nama field publik untuk kunci env yang ditolak registry. */
export const fieldOfKey = (key: string): string => (key === CENTRAL_RUNTIME_FLAG ? 'agentEngine' : 'chromiumPath')
