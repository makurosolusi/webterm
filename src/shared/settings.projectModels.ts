// `projectModels`: per-workspace model/effort override of the model ladder (server/models/modelLadder.ts).
// Absent entry or absent field = the ladder decides. Read server-side by the ladder callers.

export const PROJECT_MODEL_ALIASES = ['haiku', 'sonnet', 'opus', 'fable'] as const
export const PROJECT_MODEL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type ProjectModelAlias = (typeof PROJECT_MODEL_ALIASES)[number]
export type ProjectModelEffort = (typeof PROJECT_MODEL_EFFORTS)[number]

/** One workspace's override; each field optional (absent = ladder). */
export interface ProjectModelOverride { model?: ProjectModelAlias; effort?: ProjectModelEffort }

/** Same bounds as per-workspace wallpapers: a hand-edited document cannot grow the map unbounded. */
export const PROJECT_MODELS_LIMITS = { entries: 500, idLength: 200 } as const

const oneOf = <T extends string>(list: readonly T[], v: unknown): T | undefined =>
  typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : undefined

/** One entry normalized: unknown fields and invalid values dropped; null when nothing valid is left. */
export function normalizeProjectModel(v: unknown): ProjectModelOverride | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const src = v as Record<string, unknown>
  const model = oneOf(PROJECT_MODEL_ALIASES, src.model)
  const effort = oneOf(PROJECT_MODEL_EFFORTS, src.effort)
  if (!model && !effort) return null
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
}

/** The whole map normalized (load and PUT): bad ids and empty/invalid entries are dropped. */
export function normalizeProjectModels(v: unknown): Record<string, ProjectModelOverride> {
  const out: Record<string, ProjectModelOverride> = {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  for (const [id, entry] of Object.entries(v)) {
    if (Object.keys(out).length >= PROJECT_MODELS_LIMITS.entries) break
    if (!id || id.length > PROJECT_MODELS_LIMITS.idLength) continue
    const n = normalizeProjectModel(entry)
    if (n) out[id] = n
  }
  return out
}

/**
 * Strict check of a PATCH's `projectModels` (entry patch: `null` deletes an entry). Any entry that
 * is not `null` and not exactly a valid override is an error, so a typo is refused (400), not dropped.
 * Errors carry only position, id-free field path and code: no input value is echoed back.
 */
export function projectModelsPatchErrors(v: unknown): { index: number; field: string; code: string }[] {
  if (v === undefined) return []
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [{ index: -1, field: 'projectModels', code: 'not_object' }]
  return Object.entries(v).flatMap(([id, entry], index) => {
    if (!id || id.length > PROJECT_MODELS_LIMITS.idLength) return [{ index, field: 'projectModels.id', code: 'invalid_id' }]
    if (entry === null) return []
    const n = normalizeProjectModel(entry)
    // Every given field survived normalization = nothing unknown or invalid in it.
    const exact = n !== null && Object.keys(entry as object).length === Object.keys(n).length
    return exact ? [] : [{ index, field: 'projectModels.entry', code: 'invalid_override' }]
  })
}
