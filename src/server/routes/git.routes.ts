// Git surfaces: batch git info, Diff node, checkpoints/Rewind, Source Control, worktree workspaces.
import { gitInfoRoute } from '../gitInfo'
import { gitDiffRoute } from '../gitDiff.route'
import { gitScmRoute } from '../gitScm.route'
import { WORKSPACES_BODY_MAX_BYTES } from '../cappedRequestBody'
import { send, type ApiRoute } from './route.core'

export const gitRoutes: ApiRoute[] = [
  // Batch git state for a set of node cwds; null for anything else, including a GET of this path.
  { name: 'git-info', handle: async (c) => send(c.res, await gitInfoRoute(c.path, c.method, () => c.readBody())) },
  { name: 'git-diff', handle: async (c) => send(c.res, await gitDiffRoute(c.path, c.method, c.url.searchParams, c.body(WORKSPACES_BODY_MAX_BYTES))) },
  { name: 'checkpoint', handle: async (c) => send(c.res, await (await import('../checkpoint/checkpoint.route')).checkpointRoute(c.path, c.method, c.url.searchParams, c.body(WORKSPACES_BODY_MAX_BYTES))) },
  // Source Control panel, POSTs UI-only (gitScm.route.ts)
  { name: 'git-scm', handle: async (c) => send(c.res, await gitScmRoute(c.req, c.url, c.body(WORKSPACES_BODY_MAX_BYTES))) },
]

/** Worktree workspaces, POSTs UI-only (workspaceWorktree.route.ts). Mounted after the brief card. */
export const worktreeRoutes: ApiRoute[] = [
  { name: 'workspace-worktree', handle: async (c) => send(c.res, await (await import('../workspaceWorktree.route')).workspaceWorktreeRoute(c.req, c.url, c.body(WORKSPACES_BODY_MAX_BYTES))) },
]
