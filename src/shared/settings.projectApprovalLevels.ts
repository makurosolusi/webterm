// `projectApprovalLevels`: per-workspace override of the approval level (settings.approvalLevel.ts),
// same shape and bounds as `projectModels`. Absent entry = the global level. `approvalLevelFor` is the
// one resolver every enforcement site reads (launch flag, Agent Chat, Central guard, executor).
import type { AgentPermissionMode } from './workspace'
import { approvalLevelOf, isApprovalLevel, type ApprovalKeys, type ApprovalLevel } from './settings.approvalLevel'
import { PROJECT_MODELS_LIMITS } from './settings.projectModels'

export type ApprovalSettings = Pick<ApprovalKeys, 'skipApprovals' | 'claudePermissionMode'> & { projectApprovalLevels?: Record<string, ApprovalLevel> }

/** User-facing name of a level (events, Timeline): Ask / Auto / Danger. */
export type ApprovalModeName = 'ask' | 'auto' | 'danger'
const MODE_NAME: Record<ApprovalLevel, ApprovalModeName> = { always: 'ask', risky: 'auto', never: 'danger' }
export const approvalModeName = (level: ApprovalLevel): ApprovalModeName => MODE_NAME[level]

/** The level that applies in `workspaceId`: its override, else the global level. */
export function approvalLevelFor(s: ApprovalSettings, workspaceId?: string | null): ApprovalLevel {
  const own = workspaceId ? s.projectApprovalLevels?.[workspaceId] : undefined
  return isApprovalLevel(own) ? own : approvalLevelOf(s)
}

/** Ask-tier actions run without asking (Danger) in `workspaceId`. */
export const skipApprovalsFor = (s: ApprovalSettings, workspaceId?: string | null): boolean => approvalLevelFor(s, workspaceId) === 'never'

/**
 * Claude launch mode a level means in `workspaceId` (before a node's own mode). With no override the
 * global raw mode is kept (it may be acceptEdits/plan); an override maps Ask = manual, Auto = auto.
 */
export function claudeModeFor(s: ApprovalSettings, workspaceId?: string | null): AgentPermissionMode {
  const level = approvalLevelFor(s, workspaceId)
  if (level === 'never') return 'bypassPermissions'
  const own = workspaceId ? s.projectApprovalLevels?.[workspaceId] : undefined
  if (!isApprovalLevel(own)) return s.claudePermissionMode
  return level === 'always' ? 'manual' : 'auto'
}

/** The whole map normalized (load): bad ids and unknown levels are dropped. */
export function normalizeProjectApprovalLevels(v: unknown): Record<string, ApprovalLevel> {
  const out: Record<string, ApprovalLevel> = {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  for (const [id, level] of Object.entries(v)) {
    if (Object.keys(out).length >= PROJECT_MODELS_LIMITS.entries) break
    if (id && id.length <= PROJECT_MODELS_LIMITS.idLength && isApprovalLevel(level)) out[id] = level
  }
  return out
}

/** Strict check of a PATCH's `projectApprovalLevels` (`null` deletes an entry): a typo is refused (400), never dropped. */
export function projectApprovalLevelsPatchErrors(v: unknown): { index: number; field: string; code: string }[] {
  if (v === undefined) return []
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [{ index: -1, field: 'projectApprovalLevels', code: 'not_object' }]
  return Object.entries(v).flatMap(([id, level], index) => {
    if (!id || id.length > PROJECT_MODELS_LIMITS.idLength) return [{ index, field: 'projectApprovalLevels.id', code: 'invalid_id' }]
    return level === null || isApprovalLevel(level) ? [] : [{ index, field: 'projectApprovalLevels.entry', code: 'invalid_level' }]
  })
}

export interface ApprovalLevelChange { scope: 'global' | 'workspace'; workspaceId?: string; from: ApprovalLevel; to: ApprovalLevel }

/** Every place the effective level moved between two settings: the global level, then each workspace override set or cleared. */
export function approvalLevelChanges(prev: ApprovalSettings, next: ApprovalSettings): ApprovalLevelChange[] {
  const out: ApprovalLevelChange[] = []
  const g = { from: approvalLevelOf(prev), to: approvalLevelOf(next) }
  if (g.from !== g.to) out.push({ scope: 'global', ...g })
  const ids = new Set([...Object.keys(prev.projectApprovalLevels ?? {}), ...Object.keys(next.projectApprovalLevels ?? {})])
  for (const workspaceId of ids) {
    const before = prev.projectApprovalLevels?.[workspaceId]
    const after = next.projectApprovalLevels?.[workspaceId]
    if (before === after) continue
    out.push({ scope: 'workspace', workspaceId, from: approvalLevelFor(prev, workspaceId), to: approvalLevelFor(next, workspaceId) })
  }
  return out
}
