// Shared bits of the R0 read tools (project.read, node.list, task.status, run.result):
// the gate flag, id/page validation and text clipping. No SQL, no filesystem.
import { DERIVED_FLAGS } from '../../../../shared/featureCapabilities'
import type { ToolInput } from '../toolTypes'

/**
 * Nama kunci turunan Central dari registry (bukan literal): toolExec/toolRegistry masih mencocokkan `def.flag`
 * terhadap env, jadi pemakai di luar berkas ini butuh namanya. Kunci ini ikut `central`, bukan saklar sendiri.
 */
export function derivedFlagKey(suffix: string): string {
  return DERIVED_FLAGS.find((d) => d.key.endsWith(`_${suffix}`))?.key ?? ''
}

/** Flag turunan untuk read tools dan continuation loop (ikut `central`, ENVSIMPLE D5). */
export const READ_TOOLS_FLAG = derivedFlagKey('READ_TOOLS')

export const SAFE_ID = /^[A-Za-z0-9._:-]+$/
export const MAX_ID = 200
export const DEFAULT_PAGE = 20
export const MAX_PAGE = 50
const CLIP_MARK = '...[truncated]'

/** True for a non-empty id made of safe characters, at most `MAX_ID` long. */
export function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_ID && SAFE_ID.test(value)
}

/** Cuts `text` to `max` chars, marking the cut; shorter text is returned as is. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - CLIP_MARK.length))}${CLIP_MARK}`
}

/** Reads optional `limit`/`offset` integers; null when present but malformed or out of range. */
export function readPage(input: ToolInput, defaultLimit = DEFAULT_PAGE): { limit: number; offset: number } | null {
  const { limit = defaultLimit, offset = 0 } = input
  if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(offset)) return null
  if ((limit as number) < 1 || (limit as number) > MAX_PAGE || (offset as number) < 0) return null
  return { limit: limit as number, offset: offset as number }
}
