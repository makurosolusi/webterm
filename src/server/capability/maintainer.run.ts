// Handlers of the maintainer diagnosis capabilities (maintainer.capabilities.ts). Pure over injected facts so every path
// is testable with fakes; the real wiring is in cli.exec. Every string leaving here passes `scrubText` (secret masking,
// URL query stripping, length cap) and each answer is byte-capped.
import { isDoctorId, type DoctorCheck } from '../doctor'
import type { EffectiveRow } from '../effectiveConfig'
import { scrubText } from '../logs/logSanitize'
import { CONFIG_READ_MAX_ROWS } from './maintainer.capabilities'

/** Largest JSON answer of a maintainer capability; the rest is dropped and `truncated` says so. */
export const MAINTAINER_MAX_BYTES = 32 * 1024
const TEXT_MAX = 300

const clean = (v: unknown): string => scrubText(v, TEXT_MAX)
const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v))

/** Keeps the longest prefix of `items` whose JSON stays under `budget` bytes. */
function fit<T>(items: readonly T[], budget: number): { kept: T[]; truncated: boolean } {
  const kept: T[] = []
  let used = 2
  for (const it of items) {
    used += bytes(it) + 1
    if (used > budget) return { kept, truncated: true }
    kept.push(it)
  }
  return { kept, truncated: false }
}

export function doctorRunResult(checks: readonly DoctorCheck[], input: { id?: string }): { checks: unknown[]; summary: Record<string, number>; truncated: boolean; error?: string } {
  if (input.id !== undefined && !isDoctorId(input.id)) return { checks: [], summary: {}, truncated: false, error: 'unknown_check' }
  const picked = checks.filter((c) => input.id === undefined || c.id === input.id)
  const summary: Record<string, number> = {}
  for (const c of picked) summary[c.status] = (summary[c.status] ?? 0) + 1
  const rows = picked.map((c) => ({ id: c.id, title: clean(c.title), status: c.status, detail: clean(c.detail), ...(c.fix ? { fix: clean(c.fix) } : {}), ...(c.go ? { settingsField: c.go.field } : {}) }))
  const fitted = fit(rows, MAINTAINER_MAX_BYTES)
  return { checks: fitted.kept, summary, truncated: fitted.truncated }
}

export function configReadResult(rows: readonly EffectiveRow[], input: { q?: string; limit?: number }): { rows: unknown[]; matched: number; truncated: boolean } {
  const q = input.q?.toLowerCase()
  const matched = rows.filter((r) => q === undefined || r.key.toLowerCase().includes(q) || r.label.toLowerCase().includes(q))
  const out = matched.slice(0, Math.min(input.limit ?? CONFIG_READ_MAX_ROWS, CONFIG_READ_MAX_ROWS)).map((r) => {
    const hidden = r.secret || r.bootstrap === true // the value of a secret or bootstrap key never leaves: only whether it is set
    return {
      key: r.key, subsystem: r.subsystem, source: r.source, modified: r.modified, restart: r.restart, editable: r.editable,
      ...(r.default !== undefined && !hidden ? { default: clean(r.default) } : {}),
      ...(hidden ? { set: r.set === true } : { value: clean(r.value) }),
    }
  })
  const fitted = fit(out, MAINTAINER_MAX_BYTES)
  return { rows: fitted.kept, matched: matched.length, truncated: fitted.truncated || matched.length > out.length }
}

/** Facts `instance.info` reports; the wiring supplies them (nothing here reads the machine). */
export interface InstanceFacts {
  version: string
  production: boolean
  platform: string
  dataDirPresent: boolean
  uptimeSec: number
  sessions: number
  nodes: number
  browser: Record<string, unknown>
  image?: string
}

export function instanceInfoResult(f: InstanceFacts): Record<string, unknown> {
  const browser = Object.fromEntries(Object.entries(f.browser).map(([k, v]) => [k, typeof v === 'string' ? clean(v) : v]))
  return {
    version: clean(f.version), mode: f.production ? 'production' : 'dev', platform: clean(f.platform), dataDirPresent: f.dataDirPresent,
    uptimeSec: Math.max(0, Math.round(f.uptimeSec)), sessions: f.sessions, nodes: f.nodes, browser, ...(f.image ? { image: clean(f.image) } : {}),
  }
}
