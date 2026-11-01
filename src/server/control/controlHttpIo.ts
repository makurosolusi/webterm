// I/O kecil untuk control API: parse JSON, cek Content-Length, tulis respons. Dipisah dari
// `mount.ts` agar file route tetap di bawah budget.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { declaredLength, readCappedBody } from '../channels/channelHttp'
import { CONTROL_MAX_BODY_BYTES, headerValue } from './controlTypes'

const PARSE_FAILED = Symbol('control-json-failed')

/** Body JSON; hasil `PARSE_FAILED` dibedakan dari `{}` agar route bisa menjawab `invalid_json`. */
export function parseControlBody(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return PARSE_FAILED
  }
}

export function isParseFailure(value: unknown): boolean {
  return value === PARSE_FAILED
}

/** Hasil baca body control. `max` ikut pada overflow supaya route bisa menggemakan batasnya. */
export type ControlBodyRead =
  | { ok: true; raw: string }
  | { ok: false; reason: 'too_large'; max: number }
  | { ok: false; reason: 'read_failed' }

/**
 * Baca body control dengan batas byte SAAT streaming. `Content-Length` hanya tolak-cepat: body
 * chunked tanpa header tetap dipotong di `CONTROL_MAX_BODY_BYTES`, jadi payload raksasa tidak
 * pernah tertampung utuh di memori.
 *
 * `fallback` dipakai HANYA bila `req` bukan stream Node (fake request milik test integrasi yang
 * menyuntik reader). Request HTTP sungguhan selalu punya `.on`, jadi jalur produksi selalu lewat
 * pembaca berbatas di bawah.
 */
export async function readControlBody(
  req: IncomingMessage,
  fallback?: () => Promise<string>
): Promise<ControlBodyRead> {
  const isStream = typeof (req as { on?: unknown }).on === 'function'
  if (!isStream && fallback) {
    const raw = await fallback()
    return Buffer.byteLength(raw) > CONTROL_MAX_BODY_BYTES
      ? { ok: false, reason: 'too_large', max: CONTROL_MAX_BODY_BYTES }
      : { ok: true, raw }
  }
  const declared = declaredLength(headerValue(req.headers, 'content-length'))
  if (declared !== undefined && declared > CONTROL_MAX_BODY_BYTES) {
    return { ok: false, reason: 'too_large', max: CONTROL_MAX_BODY_BYTES }
  }
  const read = await readCappedBody(req, CONTROL_MAX_BODY_BYTES)
  if (read.ok) return { ok: true, raw: read.body }
  return read.reason === 'too_large'
    ? { ok: false, reason: 'too_large', max: CONTROL_MAX_BODY_BYTES }
    : { ok: false, reason: 'read_failed' }
}

export function writeControlJson(
  res: ServerResponse,
  status: number,
  body?: unknown
): void {
  res.statusCode = status
  if (body === undefined) {
    res.end()
    return
  }
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}
