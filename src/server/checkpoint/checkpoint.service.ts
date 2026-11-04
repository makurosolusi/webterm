// Workspace-level checkpoint operations: take one before an agent prompt / a Central act / a Halt,
// list, preview, rewind. Every call is serialised per workspace (seq numbers must not race) and
// recorded on the Senses log as `checkpoint.*` so the Activity timeline can offer Rewind.
// Callers that sit on a hot path (hook reply, tool gate) use the `*Safe` entry points: a broken
// checkpoint is logged, it never fails the prompt or the action it guards.
import type { Database } from 'bun:sqlite'
import { listWorkspaces, lookupWorkspace, projectWorkspace } from '../central/workspaceLookup'
import { activeEventLog } from '../events/eventsRuntime'
import { recordEvent } from '../events/producers'
import { resolveFsPath } from '../fsOps'
import { createLogger } from '../logs'
import {
  createCheckpoint, DEFAULT_KEEP, listCheckpoints, previewRewind, repoOf, restoreTo,
  type Checkpoint, type CreateResult, type Preview, type Repo,
} from './checkpoint.git'

const log = createLogger('checkpoint')

/** Why a checkpoint was taken; shown on the timeline. */
export type CheckpointReason = 'prompt' | 'action' | 'halt' | 'rewind'
export interface CheckpointWorkspace { id: string; cwd?: string }
export interface TakeInput { reason: CheckpointReason; nodeId?: string | null; keep?: number }
export type TakeResult = (CreateResult & { rewindable: true }) | { rewindable: false; why: 'no_cwd' | 'not_git' }

const locks = new Map<string, Promise<unknown>>()
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn)
  const tail = next.catch(() => undefined)
  locks.set(key, tail)
  void tail.then(() => { if (locks.get(key) === tail) locks.delete(key) })
  return next
}

async function repoFor(ws: CheckpointWorkspace): Promise<Repo | 'no_cwd' | 'not_git'> {
  if (!ws.cwd) return 'no_cwd'
  return (await repoOf(resolveFsPath(ws.cwd))) ?? 'not_git'
}

const headSeq = (): number | null => { try { return activeEventLog()?.head()?.seq ?? null } catch { return null } }

async function take(ws: CheckpointWorkspace, input: TakeInput): Promise<TakeResult> {
  const repo = await repoFor(ws)
  if (typeof repo === 'string') {
    // dedupeKey: one "not rewindable" row per workspace per window, not one per prompt.
    recordEvent({ kind: 'checkpoint.unavailable', source: 'checkpoint', actor: 'checkpoint', workspaceId: ws.id, nodeId: input.nodeId ?? null, trust: 'trusted', dedupeKey: `checkpoint.unavailable:${ws.id}`, payload: { why: repo, rewindable: false } })
    return { rewindable: false, why: repo }
  }
  const res = await createCheckpoint(repo, ws.id, { reason: input.reason, nodeId: input.nodeId ?? null, eventSeq: headSeq(), ts: Date.now() }, input.keep ?? DEFAULT_KEEP)
  if (!res.deduped) {
    recordEvent({ kind: 'checkpoint.created', source: 'checkpoint', actor: 'checkpoint', subject: `checkpoint:${ws.id}/${res.checkpoint.seq}`, workspaceId: ws.id, nodeId: input.nodeId ?? null, trust: 'trusted', payload: { seq: res.checkpoint.seq, reason: input.reason, pruned: res.pruned, rewindable: true } })
  }
  return { ...res, rewindable: true }
}

/** Takes a checkpoint of `ws` (deduplicated when nothing changed). Throws on git failure. */
export function takeCheckpoint(ws: CheckpointWorkspace, input: TakeInput): Promise<TakeResult> {
  return serial(ws.id, () => take(ws, input))
}

/** Hot-path variant (hook reply, tool gate, halt): never throws, logs instead. */
export async function takeCheckpointSafe(ws: CheckpointWorkspace, input: TakeInput): Promise<TakeResult | null> {
  try {
    return await takeCheckpoint(ws, input)
  } catch (err) {
    log.error('checkpoint.failed', `checkpoint before ${input.reason} failed for workspace ${ws.id}`, { error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

/** Halt: panic snapshot of every workspace with a cwd, in parallel; never throws. */
export async function panicSnapshot(workspaces: readonly CheckpointWorkspace[]): Promise<void> {
  await Promise.all(workspaces.filter((w) => w.cwd).map((w) => takeCheckpointSafe(w, { reason: 'halt' })))
}

/** Halt hook: panic snapshot of every registered workspace (none registered = nothing to do). */
export function panicSnapshotAll(): Promise<void> {
  return panicSnapshot((listWorkspaces() ?? []).flatMap((w) => (w.id ? [{ id: w.id, cwd: w.cwd }] : [])))
}

/** Central tool gate hook: checkpoint the workspace of `projectId` before an effect (tier above R0). */
export async function checkpointBeforeAction(ledger: Database, projectId: string | undefined, tier: string): Promise<void> {
  if (tier === 'R0' || !projectId) return
  let target: CheckpointWorkspace | null = null
  try {
    const pw = projectWorkspace(ledger, projectId)
    const ws = pw.ok ? lookupWorkspace(pw.workspaceId) : null
    if (pw.ok && ws) target = { id: pw.workspaceId, cwd: ws.cwd }
  } catch (err) {
    log.error('checkpoint.lookup_failed', `workspace lookup for project ${projectId} failed; action runs without a checkpoint`, { error: err instanceof Error ? err.message : String(err) })
  }
  if (target) await takeCheckpointSafe(target, { reason: 'action' })
}

export type Listing = { rewindable: true; checkpoints: Checkpoint[] } | { rewindable: false; why: 'no_cwd' | 'not_git' }

export async function listWorkspaceCheckpoints(ws: CheckpointWorkspace): Promise<Listing> {
  const repo = await repoFor(ws)
  if (typeof repo === 'string') return { rewindable: false, why: repo }
  return { rewindable: true, checkpoints: (await listCheckpoints(repo, ws.id)).reverse() }
}

export class CheckpointNotFound extends Error {}

async function resolve(ws: CheckpointWorkspace, seq: number): Promise<{ repo: Repo; target: Checkpoint } | 'not_git'> {
  const repo = await repoFor(ws)
  if (typeof repo === 'string') return 'not_git'
  const target = (await listCheckpoints(repo, ws.id)).find((c) => c.seq === seq)
  if (!target) throw new CheckpointNotFound(`checkpoint ${seq} not found in workspace ${ws.id}`)
  return { repo, target }
}

export async function previewWorkspaceRewind(ws: CheckpointWorkspace, seq: number): Promise<Preview | 'not_git'> {
  const r = await resolve(ws, seq)
  return r === 'not_git' ? r : previewRewind(r.repo, r.target)
}

export interface RewindResult { written: number; deleted: number; undoSeq: number }

/** Restores files to checkpoint `seq`; a checkpoint of the current disk is taken first (undo). */
export function rewindWorkspace(ws: CheckpointWorkspace, seq: number): Promise<RewindResult | 'not_git'> {
  return serial(ws.id, async () => {
    const r = await resolve(ws, seq)
    if (r === 'not_git') return r
    const undo = await take(ws, { reason: 'rewind' })
    if (!undo.rewindable) return 'not_git'
    const done = await restoreTo(r.repo, undo.checkpoint, r.target)
    recordEvent({ kind: 'checkpoint.rewound', source: 'checkpoint', actor: 'human-ui', subject: `checkpoint:${ws.id}/${seq}`, workspaceId: ws.id, trust: 'trusted', payload: { seq, undoSeq: undo.checkpoint.seq, ...done } })
    return { ...done, undoSeq: undo.checkpoint.seq }
  })
}
