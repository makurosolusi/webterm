// Query-string parsers shared by the read routes.
import { MAX_PROJECT_ID } from './apiShared.types'

/** `undefined` = absent, `null` = invalid. Digits only so `1e3`/`-1` never pass as a limit/page. */
export function boundedInteger(raw: string | null, min: number, max: number): number | undefined | null {
  if (raw === null) return undefined
  if (!/^\d+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null
}

/** Required `projectId` query param: trimmed, 1..MAX_PROJECT_ID chars, else `null`. */
export function projectParam(params: URLSearchParams): string | null {
  const trimmed = (params.get('projectId') ?? '').trim()
  return trimmed === '' || trimmed.length > MAX_PROJECT_ID ? null : trimmed
}
