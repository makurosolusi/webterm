// Stable identity for a health finding: the same problem keeps the same fingerprint when unrelated
// lines above it shift, so a dismissed or tracked finding is not reported again as new.
import { createHash } from 'node:crypto'
import type { HealthRule } from '../../../shared/centralHealth'

/** sha1 hex of `rule|file|key`; `key` is '' for whole-file rules (size, unreferenced). */
export function findingFingerprint(rule: HealthRule, file: string, key = ''): string {
  return createHash('sha1').update(`${rule}|${file}|${key}`).digest('hex')
}

/** Trimmed text with runs of whitespace collapsed to one space. */
export function normalizeLine(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

/** Line-shift-proof key for `lines[index]`: its normalized text plus how often that text occurred before it. */
export function lineKey(lines: readonly string[], index: number): string {
  const text = normalizeLine(lines[index] ?? '')
  let seen = 0
  for (let i = 0; i < index; i++) if (normalizeLine(lines[i] as string) === text) seen++
  return `${text}#${seen}`
}
