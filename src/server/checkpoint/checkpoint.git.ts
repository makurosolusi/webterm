// Workspace checkpoints as git objects, without touching the user's branch, HEAD or index.
//
// Imitated designs (studied):
// - Cline `CheckpointTracker` (src/integrations/checkpoints): a shadow git that stages the whole
//   workspace with `git add .` and stores a commit per step, so edits made by ANY means (shell
//   included) are captured. Here the shadow is not a second repo but a TEMPORARY INDEX
//   (`GIT_INDEX_FILE`) over the user's own object store, like `git stash create` does internally.
// - `git stash create` / `git stash -u` internals: copy the index, add worktree + untracked files,
//   `write-tree`, `commit-tree`, never moving a ref the user owns.
// - Gerrit/GitHub hidden ref namespaces (`refs/changes/*`, `refs/pull/*`): our commits live under
//   `refs/webterm/checkpoints/<workspace>/<seq>`, invisible to `git branch`/`git log`, and they keep
//   the objects alive until retention deletes the ref (then normal `git gc` reclaims them).
// - Claude Code / Cursor checkpoints: one snapshot before each prompt, restore files only. Their
//   documented gap ("changes made via Bash are not tracked") is closed because we snapshot the
//   file system, not the edit tool.
//
// Never captured: files ignored by .gitignore and secret-looking paths (`isSensitivePath`). Their
// content is never hashed (filtered BEFORE `update-index`), so no secret blob reaches .git/objects.
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import npath from 'node:path'
import { promisify } from 'node:util'
import { gitCommand } from '../gitExec'
import { isSensitivePath } from '../repoHygiene'

const run = promisify(execFile)
const GIT_TIMEOUT_MS = 60_000
const GIT_MAX_BUFFER = 256 * 1024 * 1024
export const REF_ROOT = 'refs/webterm/checkpoints'
/** Checkpoints kept per workspace; older refs are deleted after each new one. */
export const DEFAULT_KEEP = 50
/** Preview patch cap (characters); the file list is always complete. */
export const PREVIEW_PATCH_MAX = 256 * 1024
const MESSAGE_SUBJECT = 'webterm checkpoint'
const KEY_RE = /^[A-Za-z0-9_-]{1,128}$/

export interface CheckpointMeta {
  reason: string
  nodeId: string | null
  /** Senses log head when it was taken (places it on the timeline). */
  eventSeq: number | null
  ts: number
}
export interface Checkpoint extends CheckpointMeta { seq: number; commit: string; tree: string }
export interface Repo { root: string; prefix: string; index: string }
export interface FileChange { status: 'A' | 'M' | 'D' | 'T'; path: string }

/** Fixed committer identity + no optional locks; prompts/env filter/repo redirects: gitExec.ts. */
const CHECKPOINT_ENV = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_AUTHOR_NAME: 'webterm', GIT_AUTHOR_EMAIL: 'checkpoint@webterm.local',
  GIT_COMMITTER_NAME: 'webterm', GIT_COMMITTER_EMAIL: 'checkpoint@webterm.local',
}

async function git(cwd: string, args: string[], opts: { env?: Record<string, string>; input?: string } = {}): Promise<string> {
  try {
    const g = gitCommand(['-C', cwd, ...args], { env: { ...CHECKPOINT_ENV, ...opts.env } })
    const p = run(g.file, g.args, { env: g.env, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER })
    p.child.stdin?.end(opts.input ?? '')
    return (await p).stdout
  } catch (err) {
    throw new Error(`git ${args[0]} failed in ${cwd}`, { cause: err })
  }
}
const zList = (out: string): string[] => out.split('\0').filter(Boolean)

/** Ref namespace key for a workspace id; throws on anything that is not a safe refname part. */
export function refKey(workspaceId: string): string {
  if (!KEY_RE.test(workspaceId)) throw new Error(`checkpoint: unsafe workspace id ${JSON.stringify(workspaceId.slice(0, 40))}`)
  return `${REF_ROOT}/${workspaceId}`
}

/** Repo holding `cwd`, or null when it is not inside a git work tree (or does not exist). */
export async function repoOf(cwd: string): Promise<Repo | null> {
  let out: string
  try {
    const g = gitCommand(['-C', cwd, 'rev-parse', '--show-toplevel', '--show-prefix'], { env: CHECKPOINT_ENV })
    out = (await run(g.file, g.args, { env: g.env, timeout: GIT_TIMEOUT_MS })).stdout
  } catch {
    return null // not a repo (or no such dir): reported as "not rewindable", by design
  }
  const [root = '', prefix = ''] = out.split('\n')
  if (!root) return null
  const index = npath.resolve(root, (await git(root, ['rev-parse', '--git-path', 'index'])).trim())
  return { root, prefix, index }
}

const scope = (repo: Repo): string => repo.prefix || '.'

/** Tree of the workspace as it is on disk now (tracked + untracked non-ignored, minus secrets). */
export async function snapshotTree(repo: Repo): Promise<string> {
  const dir = await fs.mkdtemp(npath.join(tmpdir(), 'webterm-ckpt-'))
  const env = { GIT_INDEX_FILE: npath.join(dir, 'index') }
  try {
    // Copying the real index keeps its stat cache, so only changed files are re-hashed. Its mtime is
    // carried over too: git's racy-clean check compares file mtimes against the INDEX FILE mtime.
    try {
      await fs.copyFile(repo.index, env.GIT_INDEX_FILE)
      const st = await fs.stat(repo.index)
      await fs.utimes(env.GIT_INDEX_FILE, st.atime, st.mtime)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`checkpoint: copy index ${repo.index} failed`, { cause: err })
    }
    const changed = zList(await git(repo.root, ['diff-files', '-z', '--name-only', '--', scope(repo)], { env }))
    const untracked = zList(await git(repo.root, ['ls-files', '-z', '--others', '--exclude-standard', '--', scope(repo)], { env }))
    const add = [...changed, ...untracked].filter((p) => !p.endsWith('/') && !isSensitivePath(p))
    if (add.length) await git(repo.root, ['update-index', '--add', '--remove', '-z', '--stdin'], { env, input: add.join('\0') })
    const secrets = zList(await git(repo.root, ['ls-files', '-z'], { env })).filter(isSensitivePath)
    if (secrets.length) await git(repo.root, ['update-index', '--force-remove', '-z', '--stdin'], { env, input: secrets.join('\0') })
    return (await git(repo.root, ['write-tree'], { env })).trim()
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

/** Oldest first. */
export async function listCheckpoints(repo: Repo, workspaceId: string): Promise<Checkpoint[]> {
  const base = refKey(workspaceId)
  const out = await git(repo.root, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(tree)%00%(contents:body)%1e', `${base}/`])
  const list: Checkpoint[] = []
  for (const rec of out.split('\x1e')) {
    const [ref, commit, tree, body] = rec.replace(/^\n/, '').split('\0')
    const seq = Number(ref?.slice(base.length + 1))
    if (!ref || !commit || !tree || !Number.isSafeInteger(seq)) continue
    let meta: Partial<CheckpointMeta> = {}
    try { meta = JSON.parse(body ?? '{}') as Partial<CheckpointMeta> } catch { /* foreign/garbled message: keep the ref, blank meta */ }
    list.push({ seq, commit, tree, reason: String(meta.reason ?? 'unknown'), nodeId: meta.nodeId ?? null, eventSeq: meta.eventSeq ?? null, ts: Number(meta.ts ?? 0) })
  }
  return list.sort((a, b) => a.seq - b.seq)
}

/** Hash of the workspace subtree inside `tree`, or null when absent. */
async function subtree(repo: Repo, tree: string): Promise<string | null> {
  if (!repo.prefix) return tree
  try { return (await git(repo.root, ['rev-parse', `${tree}:${repo.prefix.replace(/\/$/, '')}`])).trim() } catch { return null }
}

export interface CreateResult { checkpoint: Checkpoint; deduped: boolean; pruned: number }

/** Stores a checkpoint unless the workspace is unchanged since the latest one (then returns that). */
export async function createCheckpoint(repo: Repo, workspaceId: string, meta: CheckpointMeta, keep = DEFAULT_KEEP): Promise<CreateResult> {
  const base = refKey(workspaceId)
  const tree = await snapshotTree(repo)
  const existing = await listCheckpoints(repo, workspaceId)
  const latest = existing.at(-1)
  if (latest && (await subtree(repo, latest.tree)) === (await subtree(repo, tree))) return { checkpoint: latest, deduped: true, pruned: 0 }
  const commit = (await git(repo.root, ['commit-tree', tree, '-m', MESSAGE_SUBJECT, '-m', JSON.stringify(meta)])).trim()
  const seq = (latest?.seq ?? 0) + 1
  await git(repo.root, ['update-ref', `${base}/${seq}`, commit, ''])
  const all = [...existing, { ...meta, seq, commit, tree }]
  const old = all.slice(0, Math.max(0, all.length - keep))
  if (old.length) await git(repo.root, ['update-ref', '--stdin'], { input: old.map((c) => `delete ${base}/${c.seq}\n`).join('') })
  return { checkpoint: all.at(-1)!, deduped: false, pruned: old.length }
}

async function changes(repo: Repo, from: string, to: string): Promise<FileChange[]> {
  const parts = zList(await git(repo.root, ['diff-tree', '-r', '-z', '--no-renames', '--name-status', from, to, '--', scope(repo)]))
  const out: FileChange[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) out.push({ status: parts[i] as FileChange['status'], path: parts[i + 1]! })
  return out
}

export interface Preview { files: FileChange[]; patch: string; truncated: boolean }

/** What rewinding to `target` would change, relative to the disk now (paths are repo-relative). */
export async function previewRewind(repo: Repo, target: Checkpoint): Promise<Preview> {
  const now = await snapshotTree(repo)
  const files = await changes(repo, now, target.tree)
  const full = files.length ? await git(repo.root, ['diff-tree', '-r', '-p', '--no-renames', '--no-color', '--no-ext-diff', now, target.tree, '--', scope(repo)]) : ''
  return { files, patch: full.slice(0, PREVIEW_PATCH_MAX), truncated: full.length > PREVIEW_PATCH_MAX }
}

/**
 * Makes the workspace files equal `target` (inside the workspace scope), via a temporary index, so
 * HEAD, branch and the user's index are never touched. `current` is the snapshot of the disk taken
 * just before (the undo checkpoint). Ignored and secret files are in neither tree, so never touched.
 */
export async function restoreTo(repo: Repo, current: Checkpoint, target: Checkpoint): Promise<{ written: number; deleted: number }> {
  const files = await changes(repo, current.tree, target.tree)
  const write = files.filter((f) => f.status !== 'D').map((f) => f.path)
  const remove = files.filter((f) => f.status === 'D').map((f) => f.path)
  if (write.length) {
    const dir = await fs.mkdtemp(npath.join(tmpdir(), 'webterm-ckpt-'))
    const env = { GIT_INDEX_FILE: npath.join(dir, 'index') }
    try {
      await git(repo.root, ['read-tree', target.tree], { env })
      await git(repo.root, ['checkout-index', '-f', '-z', '--stdin'], { env, input: write.join('\0') })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }
  for (const p of remove) await fs.rm(npath.join(repo.root, p), { force: true })
  return { written: write.length, deleted: remove.length }
}
