// workspace.create (R2) / workspace.rename (R1): Central makes a new board (one project == one workspace)
// or renames one, the way the human does (POST /api/workspaces, the header's Rename), and every open
// window updates live: a create sends `t:'workspaces'` (windows add the board), a rename rides a
// versioned `t:'canvas'` frame with `name` so an unsent save in any window neither reverts it nor 409s.
import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { WORKSPACE_HUES } from '../../../../shared/workspaceColor'
import type { ServerMsg } from '../../../../shared/protocol'
import type { Workspace } from '../../../../shared/workspace'
import type { Db } from '../../../db'
import type { CreateRefusal } from '../../../workspacesApi'
import { projectWorkspace, syncWorkspaceProjects } from '../../workspaceLookup'
import type { ToolDef, ToolInput, ToolResult } from '../toolTypes'
import { containsForbidden } from '../toolValidate'
import { obj, S } from '../../../capability/capability.schema'
import { READ_TOOLS_FLAG } from './read.shared'

/** What the tools touch, resolved per call (tests pass fakes). */
export interface WorkspaceRuntime {
  /** The human create (`createWorkspaceFrom` in workspacesApi.ts). */
  create(fields: { name: string; cwd: string; color?: string }): Promise<{ ok: true; workspace: Workspace } | { ok: false; bad: CreateRefusal }>
  db: Pick<Db, 'get' | 'save'>
  /** Send one frame to every open UI socket. */
  broadcast(msg: ServerMsg): void
  /** webterm's own data dir: never a board's cwd. */
  dataDir(): string
}
export interface WorkspaceDefsDeps {
  runtime(): WorkspaceRuntime | Promise<WorkspaceRuntime>
}

/** Central's bound on a board name (the human dialog has none; a name is a tab label). */
export const WORKSPACE_NAME_MAX = 80
const MAX_CWD = 4096
const MAX_COLOR = 32
/** Other writers (UI saves) can win between our read and write; each retry re-reads the board. */
const SAVE_ATTEMPTS = 5
const CONTROL = /[\u0000-\u001f\u007f]/

const onlyKeys = (input: ToolInput, allowed: readonly string[]): boolean => Object.keys(input).every((k) => allowed.includes(k))
const fail = (code: string): ToolResult => ({ ok: false, code })
/** Trimmed name, or null when empty, too long or holding control characters. */
const cleanName = (v: unknown): string | null => {
  const name = typeof v === 'string' ? v.trim() : ''
  return name && name.length <= WORKSPACE_NAME_MAX && !CONTROL.test(name) ? name : null
}
const inside = (dir: string, root: string): boolean => {
  const rel = relative(resolve(root), resolve(dir))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Builds workspace.create and workspace.rename bound to `deps.runtime`. */
export function createWorkspaceDefs(deps: WorkspaceDefsDeps): ToolDef[] {
  const create: ToolDef = {
    name: 'workspace.create',
    summary: 'Create a new project workspace (an empty canvas board) for an existing directory.',
    tier: 'R2',
    flag: READ_TOOLS_FLAG,
    projectScoped: false,
    usage: `{"name":"<1-${WORKSPACE_NAME_MAX} chars>","cwd":"<absolute path of an existing directory>","color":"<optional: ${WORKSPACE_HUES.join('|')}>"}. `
      + 'A new board gets an unused color at random unless you name one; the user tells boards apart by it. '
      + 'Returns {"workspaceId","projectId","name","cwd"}; projectId works in the next tool call (canvas.open, canvas.show ...). '
      + 'Every open webterm tab lists the new board; the user stays where they are (use canvas.show to switch).',
    input: obj({ name: S.str(WORKSPACE_NAME_MAX), cwd: S.str(MAX_CWD), color: S.str(MAX_COLOR) }, ['name', 'cwd']),
    output: S.keys('workspaceId', 'projectId', 'name', 'cwd'),
    auditKeys: ['workspaceId', 'projectId'],
    // `cwd` is a forbidden key for other tools but is this tool's own field: R2, so the human approves the
    // directory, and the data dir is refused below. Every other key (deep) stays forbidden.
    forbidden: ({ cwd: _cwd, ...rest }) => containsForbidden(rest),
    validate: (input) => (onlyKeys(input, ['name', 'cwd', 'color']) && typeof input.name === 'string' && typeof input.cwd === 'string'
      && (input.color === undefined || typeof input.color === 'string') ? null : 'invalid_shape'),
    async handler(ctx, input): Promise<ToolResult> {
      const name = cleanName(input.name)
      if (!name) return fail('invalid_name')
      const cwd = input.cwd as string
      if (!isAbsolute(cwd)) return fail('cwd_not_absolute')
      const rt = await deps.runtime()
      if (inside(cwd, rt.dataDir())) return fail('cwd_forbidden')
      const res = await rt.create({ name, cwd, ...(typeof input.color === 'string' ? { color: input.color } : {}) })
      if (!res.ok) {
        if (res.bad === 'cwd') return fail(existsSync(cwd) ? 'cwd_not_directory' : 'cwd_not_found')
        return fail(res.bad === 'name' ? 'invalid_name' : 'invalid_color')
      }
      const ws = res.workspace
      // The project row (id == workspace id) now, so the next call can address it.
      const live = syncWorkspaceProjects(ctx.db)
      rt.broadcast({ t: 'workspaces' })
      return { ok: true, data: { workspaceId: ws.id, projectId: live?.includes(ws.id) ? ws.id : null, name: ws.name, cwd: ws.cwd ?? cwd } }
    },
  }

  const rename: ToolDef = {
    name: 'workspace.rename',
    summary: 'Rename a project workspace (its canvas board and tab).',
    tier: 'R1',
    flag: READ_TOOLS_FLAG,
    usage: `{"projectId":"<id>","name":"<1-${WORKSPACE_NAME_MAX} chars>"}. Every open webterm tab shows the new name at once. `
      + 'Returns {"workspaceId","name","previous"}.',
    input: obj({ name: S.str(WORKSPACE_NAME_MAX) }, ['name']),
    output: S.keys('workspaceId', 'name', 'previous'),
    auditKeys: ['workspaceId'],
    validate: (input) => (onlyKeys(input, ['projectId', 'name']) && typeof input.name === 'string' ? null : 'invalid_shape'),
    async handler(ctx, input, projectId): Promise<ToolResult> {
      const name = cleanName(input.name)
      if (!name) return fail('invalid_name')
      const found = projectWorkspace(ctx.db, projectId)
      if (!found.ok) return fail(found.code)
      const { db, broadcast } = await deps.runtime()
      for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
        const ws = db.get(found.workspaceId)
        if (!ws) return fail('workspace_not_found')
        const done = { workspaceId: ws.id, name, previous: ws.name }
        if (ws.name === name) return { ok: true, data: done }
        const outcome = db.save({ ...ws, name }, ws.updatedAt)
        if (outcome === 'missing') return fail('workspace_not_found')
        if (outcome === 'stale') continue
        const updatedAt = db.get(ws.id)?.updatedAt ?? ws.updatedAt
        broadcast({ t: 'canvas', workspaceId: ws.id, base: ws.updatedAt, updatedAt, nodes: [], bridges: [], name })
        syncWorkspaceProjects(ctx.db) // the project row carries the board's name
        return { ok: true, data: done }
      }
      throw new Error(`workspace.rename of workspace ${found.workspaceId} lost ${SAVE_ATTEMPTS} save races in a row`)
    },
  }

  return [create, rename]
}
