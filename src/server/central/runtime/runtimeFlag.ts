// `WEBTERM_CENTRAL_RUNTIME` parsing (RND/13 §3 B1, §8). Default off and every
// unsupported value fail closed to `off`. Never log or return the raw value: the
// flag is configuration, but a mistyped environment can contain a credential.
import type { RuntimeKind } from './centralRuntime'

export const CENTRAL_RUNTIME_FLAG = 'WEBTERM_CENTRAL_RUNTIME'
export const DEFAULT_RUNTIME_KIND: RuntimeKind = 'off'

const SUPPORTED: ReadonlySet<string> = new Set(['off', 'claude', 'codex', 'opencode', 'mock'])

/** Case-insensitive, trimmed; anything unsupported becomes `off`. */
export function parseRuntimeKind(raw: string | null | undefined): RuntimeKind {
  const value = (raw ?? '').trim().toLowerCase()
  return SUPPORTED.has(value) ? (value as RuntimeKind) : DEFAULT_RUNTIME_KIND
}

/** Read the process flag; pass an explicit value in tests instead of mutating env. */
export function centralRuntimeKind(
  raw: string | undefined = process.env.WEBTERM_CENTRAL_RUNTIME
): RuntimeKind {
  return parseRuntimeKind(raw)
}

/** True only for an explicitly selected adapter; `off` and garbage are false. */
export function centralRuntimeEnabled(
  raw: string | undefined = process.env.WEBTERM_CENTRAL_RUNTIME
): boolean {
  return parseRuntimeKind(raw) !== 'off'
}
