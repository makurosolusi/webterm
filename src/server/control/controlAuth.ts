// Autentikasi/otorisasi bersama untuk router control. Dipisah dari `controlApi.ts` supaya modul
// route lain (`controlWait.ts`) memakai aturan yang SAMA tanpa impor melingkar.
//
// Token kapabilitas HANYA dibaca dari `x-webterm-capability`. `x-webterm-token` sengaja tidak pernah
// diperiksa di sini: token root adalah kredensial manusia, bukan grant per-node.

import type { CapabilityRecord, CapabilityVerb } from './capabilities'
import { headerValue, type ControlDeps, type ControlRequest, type ControlResult } from './controlTypes'

export type Auth = { record: CapabilityRecord } | { failure: { status: number; body: unknown } }

const unauthorized = { failure: { status: 401, body: { error: 'unauthorized' } } } as const
export const forbidden = { failure: { status: 403, body: { error: 'forbidden' } } } as const

export function authenticate(req: ControlRequest, deps: ControlDeps, now: number): Auth {
  const token = headerValue(req.headers, 'x-webterm-capability')
  if (!token) return unauthorized
  const record = deps.capabilities.verify(token, now)
  return record ? { record } : unauthorized
}

export function authorize(
  req: ControlRequest,
  deps: ControlDeps,
  now: number,
  verb: CapabilityVerb,
  resource: string,
  ctx?: Parameters<ControlDeps['capabilities']['allows']>[3]
): Auth {
  const auth = authenticate(req, deps, now)
  if ('failure' in auth) return auth
  if (!deps.capabilities.allows(auth.record, verb, resource, ctx)) return forbidden
  return auth
}

export const badRequest = (error: string): ControlResult => ({ status: 400, body: { error } })
