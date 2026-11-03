// Rute `/api/custom-agents/preview`: dry-run definisi custom agent untuk formulir Settings.
//
// TIDAK menjalankan proses apa pun: hanya validasi (`normalizeCustomAgents` mode strict, aturan
// yang sama dengan PUT /api/settings), cek keberadaan biner (`binaryExists`: akses file, bukan
// exec), dan daftar NAMA env. Nilai env tidak pernah dikembalikan (bisa literal atau rujukan).
// Auth: gerbang /api di index.ts (root token saja; path ini tak ada di allowlist node-token).
import type { IncomingMessage, ServerResponse } from 'node:http'
import { normalizeCustomAgents } from '../shared/customAgent.schema'
import { readCappedRequestBody, SETTINGS_BODY_MAX_BYTES } from './cappedRequestBody'
import { binaryExists } from './ptyShell'

export const CUSTOM_AGENTS_PREVIEW_PATH = '/api/custom-agents/preview'

/** Tier spawn central: custom agent hanya bisa dipilih central bila `centralSpawn`, dan selalu R3. */
const CENTRAL_SPAWN_TIER = 'R3'

export interface CustomAgentPreview {
  /** `[program, ...args]` apa adanya (placeholder tidak diganti); kosong bila tanpa `launch`. */
  argv: string[]
  /** null bila agent tidak punya `launch` (hanya `launchCmd` shell, tak ada program untuk dicek). */
  binaryFound: boolean | null
  envNames: string[]
  /** null bila central tidak boleh men-spawn agent ini. */
  tier: typeof CENTRAL_SPAWN_TIER | null
}

export interface CustomAgentsApiDeps {
  /** Di-inject supaya tes tidak bergantung pada PATH mesin. */
  exists?: (bin: string) => boolean
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

/** `POST` body `{agent}` -> pratinjau; 400 untuk body rusak/agent tidak sah, 405 selain POST. */
export async function customAgentsPreviewRoute(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  deps: CustomAgentsApiDeps = {}
): Promise<void> {
  if (method !== 'POST') return json(res, 405, { error: 'method not allowed' })
  const read = await readCappedRequestBody(req, SETTINGS_BODY_MAX_BYTES)
  if (!read.ok) {
    return read.reason === 'too_large'
      ? json(res, 413, { error: 'payload_too_large' })
      : json(res, 400, { error: 'body_read_failed' })
  }
  let body: unknown
  try {
    body = JSON.parse(read.body)
  } catch {
    return json(res, 400, { error: 'bad json' })
  }
  const raw = (body as { agent?: unknown } | null)?.agent
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return json(res, 400, { error: 'agent_required' })

  const { agents, errors } = normalizeCustomAgents([raw], 'strict')
  // Hanya {index, field, code}: nilai input tidak dipantulkan balik.
  if (errors.length > 0 || agents.length !== 1) return json(res, 400, { error: 'invalid_agent', errors })
  const agent = agents[0]!
  const exists = deps.exists ?? binaryExists
  const preview: CustomAgentPreview = {
    argv: agent.launch ? [agent.launch.program, ...(agent.launch.args ?? [])] : [],
    binaryFound: agent.launch ? exists(agent.launch.program) : null,
    envNames: Object.keys(agent.env ?? {}),
    tier: agent.centralSpawn === true ? CENTRAL_SPAWN_TIER : null,
  }
  json(res, 200, preview)
}
