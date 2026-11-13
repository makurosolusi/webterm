// Working-tree diff of a repo against HEAD, for the Diff node (plan I1-b, ide-parity G1).
//
// Read side imitates Orca `src/main/git/source-control/file-diff.ts` (HEAD blob vs working-tree
// file, binary flagged, size-capped like `git-show-max-bytes.ts`). Per-hunk Undo imitates VS Code's
// working-set "Undo" (revert one change): the hunk is re-derived from the CURRENT diff by id and
// reverse-applied with `git apply -R`, after `git apply -R --check` proves it still applies.
//
// Same exec pattern as `gitInfo.ts`: argv arrays (no shell), `--no-optional-locks`, filtered env
// (`ptyEnv`), `GIT_TERMINAL_PROMPT=0`, timeout. The only mutating command is `git apply -R`, and
// it only ever applies a hunk the server derived itself, never a patch from the client.
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import npath from 'node:path'
import { resolveFsPath } from './fsOps'
import { endChildStdin } from './childStdin'
import { gitCommand } from './gitExec'
import { isSensitivePath } from './repoHygiene'
import { GIT_DIFF_FILE_MAX_BYTES, type GitChange, type GitChangeStatus, type GitFileDiff, type GitHunk } from './gitDiff.types'

const GIT_TIMEOUT_MS = 10_000
const GIT_MAX_BUFFER = 32 * 1024 * 1024
/** git's own "is binary" sniff: a NUL in the first 8000 bytes (xdiff `buffer_is_binary`). */
const BINARY_SNIFF_BYTES = 8000
/** `git hash-object -t tree /dev/null`: diff base for a repo with no commit yet. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '-M']

export class GitDiffError extends Error {
  constructor(readonly code: 'not_a_repo' | 'bad_path' | 'not_changed' | 'sensitive' | 'undo_unsupported' | 'stale' | 'conflict' | 'git_failed', message: string) {
    super(message)
  }
}

interface Run { ok: boolean; stdout: string; stderr: string }

function git(cwd: string, args: string[], input?: string): Promise<Run> {
  return new Promise((resolve) => {
    const g = gitCommand(['--no-optional-locks', '-C', cwd, ...args])
    const child = execFile(g.file, g.args, { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, env: g.env }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) }))
    endChildStdin(child.stdin, input, { op: `gitDiff ${args[0]}`, command: g.file })
  })
}

/** Repo top-level for a client-supplied path (`~` expanded like `/api/fs/*`). */
export async function repoRootOf(requested: string): Promise<string> {
  const r = await git(resolveFsPath(requested), ['rev-parse', '--show-toplevel'])
  const root = r.stdout.trim()
  if (!r.ok || !root) throw new GitDiffError('not_a_repo', 'not inside a git work tree')
  return root
}

async function diffBase(root: string): Promise<string> {
  return (await git(root, ['rev-parse', '--verify', '-q', 'HEAD'])).ok ? 'HEAD' : EMPTY_TREE
}

const STATUS: Record<string, GitChangeStatus> = { A: 'added', M: 'modified', T: 'modified', D: 'deleted', R: 'renamed', C: 'added' }

async function sniffBinary(file: string): Promise<boolean> {
  const fh = await fs.open(file, 'r').catch(() => null)
  if (!fh) return false
  try {
    const buf = Buffer.alloc(BINARY_SNIFF_BYTES)
    const { bytesRead } = await fh.read(buf, 0, BINARY_SNIFF_BYTES, 0)
    return buf.subarray(0, bytesRead).includes(0)
  } finally {
    await fh.close()
  }
}

/** Every change in the work tree against HEAD (tracked + untracked, gitignored excluded), by path. */
export async function listChanges(root: string): Promise<GitChange[]> {
  const base = await diffBase(root)
  const [names, nums, others] = await Promise.all([
    git(root, ['diff', base, ...DIFF_FLAGS, '--name-status', '-z']),
    git(root, ['diff', base, ...DIFF_FLAGS, '--numstat', '-z']),
    git(root, ['ls-files', '--others', '--exclude-standard', '-z']),
  ])
  if (!names.ok || !nums.ok || !others.ok) throw new GitDiffError('git_failed', `git diff failed: ${(names.stderr || nums.stderr || others.stderr).trim()}`)
  // numstat -z: "a\tb\tpath\0", or for a rename "a\tb\t\0old\0new\0"; binary = "-\t-".
  const binary = new Set<string>()
  const ns = nums.stdout.split('\0')
  for (let i = 0; i < ns.length; i++) {
    const [a, , p] = ns[i].split('\t')
    const path = p === '' ? ns[(i += 2)] : p
    if (a === '-' && path) binary.add(path)
  }
  const out: GitChange[] = []
  const f = names.stdout.split('\0')
  for (let i = 0; i + 1 < f.length; i++) {
    const code = f[i][0]
    const status = STATUS[code] ?? 'modified'
    const oldPath = code === 'R' || code === 'C' ? f[++i] : undefined
    const path = f[++i]
    if (!path) break
    out.push({ path, ...(code === 'R' ? { oldPath } : {}), status, binary: binary.has(path), sensitive: isSensitivePath(path) || (!!oldPath && isSensitivePath(oldPath)) })
  }
  for (const path of others.stdout.split('\0').filter(Boolean)) {
    out.push({ path, status: 'untracked', binary: false, sensitive: isSensitivePath(path) })
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** Fill `binary` for untracked entries (git does not know); only for the page being served. */
export async function sniffUntracked(root: string, files: GitChange[]): Promise<GitChange[]> {
  return Promise.all(files.map(async (c) => (c.status === 'untracked' && !c.sensitive ? { ...c, binary: await sniffBinary(npath.join(root, c.path)) } : c)))
}

/** A repo-relative path that stays inside the repo; anything else is a client bug or an attack. */
export function checkRelPath(p: unknown): string {
  if (typeof p !== 'string' || p === '' || npath.isAbsolute(p) || p.includes('\0') || p.split(/[\\/]/).includes('..')) {
    throw new GitDiffError('bad_path', 'path must be repo-relative')
  }
  return p
}

async function findChange(root: string, path: string): Promise<GitChange> {
  // ponytail: one full listing per file request; cache per (root, mtime) if huge repos feel slow.
  const change = (await listChanges(root)).find((c) => c.path === path)
  if (!change) throw new GitDiffError('not_changed', 'path has no changes')
  return change
}

/** Split `git diff` output for one file into its header and hunks (id = sha1 of header + hunk). */
export function parseHunks(patch: string): { header: string; hunks: (GitHunk & { text: string })[] } {
  const lines = patch.split('\n')
  const first = lines.findIndex((l) => l.startsWith('@@ '))
  if (first < 0) return { header: patch, hunks: [] }
  const header = lines.slice(0, first).join('\n') + '\n'
  const hunks: (GitHunk & { text: string })[] = []
  let cur: string[] = []
  const flush = () => {
    if (!cur.length) return
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(cur[0])
    const text = cur.join('\n') + '\n'
    if (m) hunks.push({
      id: createHash('sha1').update(header + text).digest('hex').slice(0, 16),
      header: cur[0], oldStart: +m[1], oldLines: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newLines: m[4] === undefined ? 1 : +m[4], text,
    })
    cur = []
  }
  for (const l of lines.slice(first)) {
    if (l.startsWith('@@ ')) flush()
    if (l !== '') cur.push(l)
  }
  flush()
  return { header, hunks }
}

async function filePatch(root: string, c: GitChange): Promise<string> {
  const base = await diffBase(root)
  const r = await git(root, ['diff', base, ...DIFF_FLAGS, '-U3', '--', ...(c.oldPath ? [c.oldPath] : []), c.path])
  if (!r.ok) throw new GitDiffError('git_failed', `git diff failed: ${r.stderr.trim()}`)
  return r.stdout
}

async function headSize(root: string, spec: string): Promise<number> {
  return Number((await git(root, ['cat-file', '-s', spec])).stdout.trim()) || 0
}

/** Both sides + hunks of one changed file; contents withheld for binary, sensitive and oversized files. */
export async function fileDiff(root: string, rel: string): Promise<GitFileDiff> {
  const path = checkRelPath(rel)
  let c = await findChange(root, path)
  if (c.status === 'untracked') [c] = await sniffUntracked(root, [c])
  const empty: GitFileDiff = { ...c, original: '', modified: '', truncated: false, hunks: [], undoable: false }
  if (c.sensitive || c.binary) return empty
  const base = await diffBase(root)
  const headSpec = `${base}:${c.oldPath ?? c.path}`
  const hasHead = c.status !== 'added' && c.status !== 'untracked'
  const hasWork = c.status !== 'deleted'
  const workFile = npath.join(root, c.path)
  const sizes = await Promise.all([hasHead ? headSize(root, headSpec) : 0, hasWork ? fs.stat(workFile).then((s) => s.size, () => 0) : 0])
  if (sizes.some((s) => s > GIT_DIFF_FILE_MAX_BYTES)) return { ...empty, truncated: true }
  const [original, modified] = await Promise.all([
    hasHead ? git(root, ['show', headSpec]).then((r) => r.stdout) : '',
    hasWork ? fs.readFile(workFile, 'utf8') : '',
  ])
  const undoable = c.status === 'modified' || c.status === 'deleted'
  const hunks = c.status === 'untracked' ? [] : parseHunks(await filePatch(root, c)).hunks.map(({ text: _t, ...h }) => h)
  return { ...c, original, modified, truncated: false, hunks, undoable }
}

/** Revert one hunk in the working tree. Refuses when the hunk is gone (stale) or no longer applies. */
export async function undoHunk(root: string, rel: string, hunkId: string): Promise<void> {
  const path = checkRelPath(rel)
  const c = await findChange(root, path)
  if (c.sensitive) throw new GitDiffError('sensitive', 'sensitive file')
  if (c.binary || (c.status !== 'modified' && c.status !== 'deleted')) throw new GitDiffError('undo_unsupported', `undo is not available for ${c.status} files`)
  const { header, hunks } = parseHunks(await filePatch(root, c))
  const hunk = hunks.find((h) => h.id === hunkId)
  if (!hunk) throw new GitDiffError('stale', 'the file changed since the diff was loaded; refresh and try again')
  const patch = header + hunk.text
  const check = await git(root, ['apply', '-R', '--check', '-'], patch)
  if (!check.ok) throw new GitDiffError('conflict', `hunk no longer applies: ${check.stderr.trim()}`)
  const apply = await git(root, ['apply', '-R', '-'], patch)
  if (!apply.ok) throw new GitDiffError('conflict', `git apply failed: ${apply.stderr.trim()}`)
}
