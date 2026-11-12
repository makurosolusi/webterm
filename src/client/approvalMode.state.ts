// Saving a permission mode (Ask / Auto / Danger), globally or for one project, for every surface that
// changes it (Settings › Claude › Permissions, the Central chat chip). Writes straight to the server,
// not through the settings coalescer: a switch to Danger must carry `confirmDanger: true`, and the
// server's 400 `confirm_required` must reopen the confirmation instead of failing silently.
// Feedback uses the Settings save states (Saving… / Saved ✓ / error + Retry) under the key it writes.
import { useCallback, useState } from 'react'
import type { Settings } from '../shared/settings'
import { approvalLevelOf, type ApprovalLevel } from '../shared/settings.approvalLevel'
import { approvalLevelFor } from '../shared/settings.projectApprovalLevels'
import { reloadSettings, settingsSaves, settingsUrl } from './useSettings'

/** Where a choice applies: every project, or one workspace (`level: null` there = back to all projects). */
export type ApprovalTarget = { scope: 'global' } | { scope: 'workspace'; workspaceId: string }

/** Settings key whose save state shows a target's progress. */
export const approvalSaveKey = (t: ApprovalTarget): 'agentApprovalLevel' | 'projectApprovalLevels' =>
  t.scope === 'global' ? 'agentApprovalLevel' : 'projectApprovalLevels'

export const APPROVAL_SESSIONS_URL = '/api/settings/approval-sessions'

type PutResult = { ok: true } | { ok: false; confirm: true } | { ok: false; confirm?: false; message: string }

async function putLevel(t: ApprovalTarget, level: ApprovalLevel | null, confirmDanger: boolean): Promise<PutResult> {
  const patch = t.scope === 'global' ? { agentApprovalLevel: level } : { projectApprovalLevels: { [t.workspaceId]: level } }
  const res = await fetch(settingsUrl(), {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...patch, ...(confirmDanger ? { confirmDanger: true } : {}) }),
  })
  if (res.ok) return { ok: true }
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null
  if (res.status === 400 && body?.error === 'confirm_required') return { ok: false, confirm: true }
  return { ok: false, message: typeof body?.error === 'string' ? body.error : `PUT /api/settings -> ${res.status}` }
}

/** Running terminal sessions in `workspaceId` (absent = every project) still on an older mode. */
export async function fetchStaleSessions(workspaceId?: string): Promise<number> {
  const res = await fetch(`${APPROVAL_SESSIONS_URL}${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''}`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`GET ${APPROVAL_SESSIONS_URL} -> ${res.status}`)
  const n = ((await res.json()) as { staleSessions?: unknown }).staleSessions
  return typeof n === 'number' ? n : 0
}

/** The line under a control after a save; null when nothing keeps an old mode. */
export const staleSessionsText = (n: number): string | null => n <= 0 ? null
  : n === 1 ? '1 running terminal session keeps its old mode until restarted.'
    : `${n} running terminal sessions keep their old mode until restarted.`

/** The level a target has now (a workspace without an override follows all projects). */
export const levelAt = (s: Settings, t: ApprovalTarget): ApprovalLevel =>
  t.scope === 'global' ? approvalLevelOf(s) : approvalLevelFor(s, t.workspaceId)

export interface Asking { target: ApprovalTarget; level: ApprovalLevel | null }

export interface ApprovalModeChange {
  /** Choose a level; a change that lands on Danger asks first (`asking`). */
  choose(target: ApprovalTarget, level: ApprovalLevel | null): void
  /** The Danger confirmation waiting for an answer; null = no dialog. */
  asking: Asking | null
  confirm(): void
  cancel(): void
  /** Running terminal sessions still on an old mode after the last save. */
  stale: number
}

export function useApprovalModeChange(settings: Settings): ApprovalModeChange {
  const [asking, setAsking] = useState<Asking | null>(null)
  const [stale, setStale] = useState(0)

  const send = useCallback(async (a: Asking, confirmDanger: boolean): Promise<void> => {
    const settle = settingsSaves.start([approvalSaveKey(a.target)])
    const retry = (): void => { void send(a, confirmDanger) }
    try {
      const r = await putLevel(a.target, a.level, confirmDanger)
      if (!r.ok && r.confirm) {
        // The server wants the confirmation (another tab moved the level, or it was never asked): ask again.
        settle({ ok: false, message: 'Danger needs your confirmation', retry: () => setAsking(a) })
        setAsking(a)
        return
      }
      if (!r.ok) { settle({ ok: false, message: r.message, retry }); return }
    } catch (err) {
      settle({ ok: false, message: err instanceof Error ? err.message : String(err), retry })
      return
    }
    settle({ ok: true })
    await reloadSettings()
    // Read-only extra: the save already succeeded, so a failed count is reported, not shown as a failed save.
    fetchStaleSessions(a.target.scope === 'workspace' ? a.target.workspaceId : undefined)
      .then(setStale, (err: unknown) => console.error('approval-sessions count failed', err))
  }, [])

  const choose = (target: ApprovalTarget, level: ApprovalLevel | null): void => {
    const before = levelAt(settings, target)
    const after = level ?? approvalLevelOf(settings)
    if (target.scope === 'workspace' && (level ?? undefined) === settings.projectApprovalLevels[target.workspaceId]) return
    if (target.scope === 'global' && level === before) return
    if (after === 'never' && before !== 'never') { setAsking({ target, level }); return }
    void send({ target, level }, false)
  }

  return {
    choose, asking, stale,
    confirm: () => { if (asking) { const a = asking; setAsking(null); void send(a, true) } },
    cancel: () => setAsking(null),
  }
}
