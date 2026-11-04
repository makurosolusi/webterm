// HTTP for workspace checkpoints (Activity timeline Rewind). Root token / same-origin UI only, like
// /api/events (not in `isNodeTokenPath`): an agent must not rewind the files a human is reviewing.
//   GET  /api/checkpoints?workspace=<id>                -> { rewindable, checkpoints | why }
//   GET  /api/checkpoints/preview?workspace=<id>&seq=<n> -> { files, patch, truncated }
//   POST /api/checkpoints/rewind { workspace, seq }       -> { written, deleted, undoSeq }
import type { RouteResult } from '../apiShared.types'
import {
  CheckpointNotFound, listWorkspaceCheckpoints, previewWorkspaceRewind, rewindWorkspace, type CheckpointWorkspace,
} from './checkpoint.service'

export const CHECKPOINTS_PATH = '/api/checkpoints'
export const CHECKPOINT_BODY_MAX_BYTES = 4 * 1024

export interface CheckpointRouteDeps { workspace(id: string): CheckpointWorkspace | null | undefined }

/** Loaded lazily: `db` pulls bun:sqlite and the real data dir, which tests must not open. */
async function defaultDeps(): Promise<CheckpointRouteDeps> {
  const { db } = await import('../db')
  return { workspace: (id) => db.get(id) }
}

const fail = (status: number, error: string): RouteResult => ({ status, body: { error } })
const seqOf = (v: unknown): number | null => {
  const n = typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : v
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null
}

/** null = not a checkpoint path. */
export async function checkpointRoute(
  path: string, method: string, query: URLSearchParams, body: () => Promise<string>, deps?: CheckpointRouteDeps,
): Promise<RouteResult | null> {
  if (path !== CHECKPOINTS_PATH && !path.startsWith(`${CHECKPOINTS_PATH}/`)) return null
  const sub = path.slice(CHECKPOINTS_PATH.length)
  const want = sub === '/rewind' ? 'POST' : sub === '' || sub === '/preview' ? 'GET' : null
  if (!want) return fail(404, 'unknown route')
  if (method !== want) return fail(405, 'method_not_allowed')
  let input: Record<string, unknown> = Object.fromEntries(query)
  if (want === 'POST') {
    try { input = JSON.parse(await body()) as Record<string, unknown> } catch { return fail(400, 'invalid_body') }
    if (typeof input !== 'object' || input === null) return fail(400, 'invalid_body')
  }
  const id = typeof input.workspace === 'string' ? input.workspace : ''
  const ws = id ? (deps ?? (await defaultDeps())).workspace(id) : null
  if (!ws) return fail(404, 'workspace_not_found')
  if (sub === '') return { status: 200, body: await listWorkspaceCheckpoints(ws) }
  const seq = seqOf(input.seq)
  if (seq === null) return fail(400, 'invalid_seq')
  try {
    const out = sub === '/preview' ? await previewWorkspaceRewind(ws, seq) : await rewindWorkspace(ws, seq)
    return out === 'not_git' ? fail(409, 'not_rewindable') : { status: 200, body: out }
  } catch (err) {
    if (err instanceof CheckpointNotFound) return fail(404, 'checkpoint_not_found')
    throw err
  }
}
