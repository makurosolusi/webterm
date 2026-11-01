// I/O kecil untuk control API: parse JSON, cek Content-Length, tulis respons. Dipisah dari
// `mount.ts` agar file route tetap di bawah budget.
import type { IncomingMessage, ServerResponse } from 'node:http'
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

/** `Content-Length` hanya tolak-cepat; akumulasi byte tetap diperiksa setelah baca. */
export function declaredTooLarge(headers: IncomingMessage['headers']): boolean {
  const raw = headerValue(headers, 'content-length')
  if (raw === undefined) return false
  const n = Number(raw)
  return Number.isFinite(n) && n > CONTROL_MAX_BODY_BYTES
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
