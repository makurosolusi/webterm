// `WEBTERM_CENTRAL_RUNTIME` parsing (RND/13 §3 B1, §8). Default off and every
// unsupported value fail closed to `off`. Never log or return the raw value: the
// flag is configuration, but a mistyped environment can contain a credential.
import type { RuntimeKind } from './centralRuntime'
import { RETIRED_RUNTIME_KINDS, SUPPORTED_RUNTIME_KINDS, type WhichFn, detectAgentEngine } from './runtimeDetect'

export const CENTRAL_RUNTIME_FLAG = 'WEBTERM_CENTRAL_RUNTIME'
export const DEFAULT_RUNTIME_KIND: RuntimeKind = 'off'

/** Case-insensitive, trimmed; anything unsupported becomes `off`. */
export function parseRuntimeKind(raw: string | null | undefined): RuntimeKind {
  const value = (raw ?? '').trim().toLowerCase()
  return SUPPORTED_RUNTIME_KINDS.has(value) ? (value as RuntimeKind) : DEFAULT_RUNTIME_KIND
}

/**
 * Tak diset (undefined) atau mesin pensiunan (opencode/codex) = deteksi otomatis (claude, lalu off; tak pernah mock);
 * string lain, termasuk kosong, di-parse fail-closed.
 */
export function centralRuntimeKind(
  raw: string | undefined = process.env.WEBTERM_CENTRAL_RUNTIME,
  which?: WhichFn
): RuntimeKind {
  const auto = raw === undefined || RETIRED_RUNTIME_KINDS.has(raw.trim().toLowerCase())
  return auto ? detectAgentEngine({}, which) : parseRuntimeKind(raw)
}

/** True untuk mesin terpilih atau terdeteksi; `off` dan nilai tak dikenal false. */
export function centralRuntimeEnabled(
  raw: string | undefined = process.env.WEBTERM_CENTRAL_RUNTIME,
  which?: WhichFn
): boolean {
  return centralRuntimeKind(raw, which) !== 'off'
}
