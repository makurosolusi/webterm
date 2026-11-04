// Acceptance A1: the secrets guard runs for a workspace as soon as it is created or its cwd changes,
// without a server restart. The guard itself is covered by repoHygiene.bun.test.ts; here only the
// call site is asserted.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Workspace } from '../shared/workspace'
import { DEFAULT_VIEWPORT } from '../shared/workspace'
import type { Db } from './db'

const guard = vi.hoisted(() => vi.fn(async () => []))
vi.mock('./repoHygiene', () => ({ guardWorkspaceRepos: guard }))
const { workspacesRoute } = await import('./workspacesApi')

function store(): Db {
  const rows = new Map<string, Workspace>()
  return {
    get: (id: string) => rows.get(id) ?? null,
    create: (name: string, cwd?: string) => {
      const ws: Workspace = { id: 'ws1', name, cwd, viewport: DEFAULT_VIEWPORT, nodes: [], bridges: [], updatedAt: 1 }
      rows.set(ws.id, ws)
      return ws
    },
    save: (ws: Workspace) => void rows.set(ws.id, ws),
  } as unknown as Db
}

const body = (o: object) => async () => JSON.stringify(o)
const save = (cwd: string) => body({ name: 'p', cwd, viewport: DEFAULT_VIEWPORT, nodes: [] })

describe('workspacesRoute secrets guard', () => {
  beforeEach(() => guard.mockClear())

  it('guards on create, on cwd change, and not on a save that keeps the cwd', async () => {
    const s = store()
    await workspacesRoute(s, '/api/workspaces', 'POST', body({ name: 'p', cwd: '/repo/a' }))
    expect(guard).toHaveBeenCalledTimes(1)
    expect(guard).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'ws1', cwd: '/repo/a' })])

    await workspacesRoute(s, '/api/workspaces/ws1', 'PUT', save('/repo/a'))
    expect(guard).toHaveBeenCalledTimes(1)

    await workspacesRoute(s, '/api/workspaces/ws1', 'PUT', save('/repo/b'))
    expect(guard).toHaveBeenCalledTimes(2)
    expect(guard).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'ws1', cwd: '/repo/b' })])
  })
})
