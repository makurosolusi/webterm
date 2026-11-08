// Per-project model override: Settings `projectModels[projectId | workspaceId]` (written by the
// settings UI). Like claudeLauncher, the settings reader is registered by db.ts so importing this
// module never opens the database; unregistered = no overrides.
import type { Effort, ResolveInput } from './modelLadder'

const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']
const MODEL_MAX = 100

let read: () => unknown = () => ({})

/** Wire the settings store (db.ts). Tests pass their own reader. */
export function registerModelSettings(reader: () => unknown): void {
  read = reader
}

/** The user's model/effort pick for `id` (project or workspace id), or null when none is set or it is malformed. */
export function projectModelOverride(id: string | null | undefined): NonNullable<ResolveInput['override']> | null {
  if (!id) return null
  const all = (read() as { projectModels?: unknown } | null)?.projectModels
  if (!all || typeof all !== 'object') return null
  const raw = (all as Record<string, unknown>)[id]
  if (!raw || typeof raw !== 'object') return null
  const { model, effort } = raw as { model?: unknown; effort?: unknown }
  const out: { model?: string; effort?: Effort } = {}
  if (typeof model === 'string' && model.trim() && model.length <= MODEL_MAX) out.model = model.trim()
  if (typeof effort === 'string' && EFFORTS.includes(effort)) out.effort = effort as Effort
  return out.model || out.effort ? out : null
}
