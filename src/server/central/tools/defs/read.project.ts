// project.read (R0): shallow project snapshot for central: branch, top-level entries and the
// head of README.md / CLAUDE.md. Read-only; symlinks, .git and env/secret-looking names are skipped.
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { getRow } from '../../../ledger/ledgerCore'
import { scopeFromConversationId } from '../../conversationModel'
import { livePortfolio } from '../../workspaceLookup'
import type { ToolDef, ToolResult } from '../toolTypes'
import { MAX_PAGE, READ_TOOLS_FLAG, readPage } from './read.shared'
import { obj, S } from '../../../capability/capability.schema'

const MAX_ENTRIES = 60
const DOC_BYTES = 2048
const HEAD_PREFIX = 'ref: refs/heads/'
const GITDIR_PREFIX = 'gitdir:'
const DETACHED_SHA_CHARS = 8
const SKIP_NAMES = new Set(['.git', 'node_modules'])
const SECRET_NAME = /^\.env|\.(pem|key|p12|pfx)$|^credentials/i

/** First `DOC_BYTES` bytes of a regular file (never through a symlink), or null when absent. */
function readHead(dir: string, name: string): string | null {
  const file = join(dir, name)
  let stat
  try { stat = lstatSync(file) } catch { return null } // absent doc is a normal state, not an error
  if (!stat.isFile()) return null
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(DOC_BYTES)
    return buf.toString('utf8', 0, readSync(fd, buf, 0, DOC_BYTES, 0))
  } finally { closeSync(fd) }
}

/** Current branch (or short sha when detached) from `.git/HEAD`; handles worktree `.git` files. */
function readBranch(dir: string): string | null {
  try {
    const dotGit = join(dir, '.git')
    let gitDir = dotGit
    if (lstatSync(dotGit).isFile()) {
      const line = readFileSync(dotGit, 'utf8').trim()
      if (!line.startsWith(GITDIR_PREFIX)) return null
      gitDir = join(dir, line.slice(GITDIR_PREFIX.length).trim())
    }
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    return head.startsWith(HEAD_PREFIX) ? head.slice(HEAD_PREFIX.length) : head.slice(0, DETACHED_SHA_CHARS)
  } catch {
    return null // not a git checkout: branch is simply unknown
  }
}

const projectRead: ToolDef = {
  name: 'project.read',
  summary: 'Read a project: branch, top-level files and the head of README.md and CLAUDE.md.',
  tier: 'R0',
  flag: READ_TOOLS_FLAG,
  usage: '{"projectId":"<id>"}. Read-only; returns truncated text, never secrets.',
  input: obj({}),
  output: S.keys('project', 'branch', 'entriesTotal', 'entries', 'readme', 'claudeMd'),
  validate: () => null,
  handler(ctx, _input, projectId): ToolResult {
    const row = getRow(ctx.db, 'SELECT name, path, status, branch_base FROM project WHERE id = ?', projectId)
    if (!row) return { ok: false, code: 'project_not_found' }
    const dir = String(row['path'])
    let names: Array<{ name: string; dir: boolean }>
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((e) => !SKIP_NAMES.has(e.name) && !SECRET_NAME.test(e.name))
        .map((e) => ({ name: e.name, dir: e.isDirectory() }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    } catch {
      return { ok: false, code: 'path_unreadable' } // message dropped: it would echo the absolute path
    }
    return {
      ok: true,
      data: {
        project: { id: projectId, name: row['name'], status: row['status'], branchBase: row['branch_base'] ?? null },
        branch: readBranch(dir),
        entriesTotal: names.length,
        entries: names.slice(0, MAX_ENTRIES).map((e) => (e.dir ? `${e.name}/` : e.name)),
        readme: readHead(dir, 'README.md'),
        claudeMd: readHead(dir, 'CLAUDE.md'),
      },
    }
  },
}

const projectList: ToolDef = {
  name: 'project.list',
  summary: 'List every project (one per canvas workspace) with task, approval and pending plan counts, paginated.',
  tier: 'R0',
  flag: READ_TOOLS_FLAG,
  projectScoped: false,
  usage: '{"limit":<1-50, optional, default 20>,"offset":<>=0, optional>}. boundProjectId is the project this chat is bound to.',
  input: obj({ limit: S.int(1, MAX_PAGE), offset: S.int(0) }),
  output: S.keys('total', 'offset', 'boundProjectId', 'projects'),
  validate: (input) => (readPage(input) ? null : 'invalid_shape'),
  handler(ctx, input): ToolResult {
    const page = livePortfolio(ctx.db, readPage(input) ?? {})
    const scope = scopeFromConversationId(ctx.conversationId)
    return {
      ok: true,
      data: {
        total: page.total,
        offset: page.offset,
        boundProjectId: scope.kind === 'project' ? scope.projectId : null,
        projects: page.items.map((p) => ({
          id: p.id, name: p.name, status: p.status, tasks: p.taskTotal,
          pendingApprovals: p.pendingApprovals, pendingPlanItems: p.plan?.items.pending ?? 0,
        })),
      },
    }
  },
}

/** R0 project read tools. */
export const PROJECT_READ_DEFS: readonly ToolDef[] = [projectRead, projectList]
