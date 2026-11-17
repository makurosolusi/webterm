// Root-only routes for desktop -> Telegram forwarding (authorization happens before handleApi):
//   POST /api/channels/presence               {visible: boolean, muted?: string[], nodeId?: string|null, workspaceId?: string|null, idleMs?: number} -> 204 (tab heartbeat)
//   GET  /api/channels/telegram/forwarding    -> {awayMinutes}
//   PUT  /api/channels/telegram/forwarding    {awayMinutes: 0..1440} -> {awayMinutes} (0 = off)
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readCappedBody, writeJson } from './channelHttp'
import type { PresenceTracker } from './channelPresence'
import { MAX_FORWARD_AWAY_MINUTES } from './channelStoreSchema'
import { createLogger } from '../logs'

export const PRESENCE_PATH = '/api/channels/presence'
export const FORWARDING_PATH = '/api/channels/telegram/forwarding'
const MAX_BODY_BYTES = 16 * 1024
const MAX_MUTED = 500
const log = createLogger('channels')

export interface PresenceHttpDeps {
  presence: PresenceTracker
  store: { readonly forwardAwayMinutes: number; setForwardAwayMinutes(minutes: number): void }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const body = await readCappedBody(req, MAX_BODY_BYTES)
  if (!body.ok) return null
  try {
    const parsed: unknown = JSON.parse(body.body)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const isOptionalId = (v: unknown): boolean => v === undefined || v === null || (typeof v === 'string' && v.length > 0 && v.length <= 200)

const isOptionalMs = (v: unknown): boolean => v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 86_400_000)

function isMutedList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_MUTED && value.every((id) => typeof id === 'string' && id.length <= 200)
}

/** True when this handler owns the path. */
export function handleChannelPresenceApi(req: IncomingMessage, res: ServerResponse, deps: PresenceHttpDeps): boolean {
  const path = new URL(req.url || '/', 'http://x').pathname
  const method = (req.method ?? '').toUpperCase()
  if (path === PRESENCE_PATH) {
    if (method !== 'POST') return methodNotAllowed(req, res, 'POST')
    void readJson(req).then((body) => {
      if (!body || typeof body['visible'] !== 'boolean' || (body['muted'] !== undefined && !isMutedList(body['muted']))
        || !isOptionalId(body['nodeId']) || !isOptionalId(body['workspaceId']) || !isOptionalMs(body['idleMs'])) {
        return writeJson(res, 400, { ok: false, error: 'invalid_presence' })
      }
      deps.presence.note({
        visible: body['visible'],
        ...(typeof body['idleMs'] === 'number' ? { idleMs: body['idleMs'] } : {}),
        ...(body['muted'] === undefined ? {} : { muted: body['muted'] as string[] }),
        ...(body['nodeId'] === undefined ? {} : { nodeId: body['nodeId'] as string | null, workspaceId: (body['workspaceId'] as string | null | undefined) ?? null }),
      })
      res.statusCode = 204
      res.end()
    })
    return true
  }
  if (path !== FORWARDING_PATH) return false
  if (method === 'GET') {
    req.resume()
    writeJson(res, 200, { awayMinutes: deps.store.forwardAwayMinutes })
    return true
  }
  if (method !== 'PUT') return methodNotAllowed(req, res, 'GET, PUT')
  void readJson(req).then((body) => {
    const minutes = body?.['awayMinutes']
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 0 || minutes > MAX_FORWARD_AWAY_MINUTES) {
      return writeJson(res, 400, { ok: false, error: 'invalid_away_minutes' })
    }
    try {
      deps.store.setForwardAwayMinutes(minutes)
    } catch (err) {
      log.warn('channels.forwarding_save_failed', 'saving the forwarding delay failed', { error: err instanceof Error ? err.message : typeof err })
      return writeJson(res, 500, { ok: false, error: 'store_unavailable' })
    }
    writeJson(res, 200, { awayMinutes: minutes })
  })
  return true
}

function methodNotAllowed(req: IncomingMessage, res: ServerResponse, allow: string): true {
  req.resume()
  writeJson(res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: allow })
  return true
}
