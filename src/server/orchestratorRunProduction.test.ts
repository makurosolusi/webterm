// Focused tests for the server-side composition split out of orchestratorRunApi.
// Route-level behavior stays covered by orchestratorRunApi.test.ts.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlanItem } from './orchestrator/planModel'
import type { WorktreeService } from './orchestrator/worktree'
import {
  assignmentProblem,
  projectRepo,
  resolveWorktrees,
  worktreeRoot,
} from './orchestratorRunProduction'

const tempDirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'webterm-prod-'))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function item(patch: Partial<PlanItem> = {}): PlanItem {
  return {
    id: 'i1',
    planId: 'pl1',
    seq: 0,
    taskId: 't1',
    title: 'build API',
    scope: ['src/server'],
    status: 'assigned',
    assignee: 'ag1',
    assignedAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

function planStore(entry: PlanItem | null) {
  return {
    get: () =>
      entry === null
        ? null
        : {
            id: 'pl1',
            projectId: 'p1',
            version: 1,
            status: 'active' as const,
            items: [entry],
            createdAt: 1,
            updatedAt: 1,
          },
  }
}

describe('orchestratorRunProduction', () => {
  it('reads the repo path from the project row only', () => {
    const db = { query: () => ({ get: () => ({ path: '/srv/repo' }) }) }
    expect(projectRepo(db as never, 'p1')).toBe('/srv/repo')
    const blank = { query: () => ({ get: () => ({ path: '   ' }) }) }
    expect(projectRepo(blank as never, 'p1')).toBeNull()
    const missing = { query: () => ({ get: () => null }) }
    expect(projectRepo(missing as never, 'p1')).toBeNull()
  })

  it('accepts only an assigned item that has a task and assignee', () => {
    expect(assignmentProblem(planStore(item()), 'p1', 'i1')).toBeNull()
    expect(assignmentProblem(planStore(item({ status: 'pending' })), 'p1', 'i1')).toContain('is pending')
    expect(assignmentProblem(planStore(item({ taskId: null })), 'p1', 'i1')).toContain('is assigned')
    expect(assignmentProblem(planStore(null), 'p1', 'i1')).toBe('project p1 has no plan')
    expect(assignmentProblem(planStore(item()), 'p1', 'nope')).toBe('no item nope in plan pl1')
    const broken = {
      get: () => {
        throw new Error('db gone')
      },
    }
    expect(assignmentProblem(broken, 'p1', 'i1')).toBe('plan store unavailable for project p1')
  })

  it('puts the worktree root under the data dir', () => {
    expect(worktreeRoot({ ledger: null, dataDir: () => '/data' })).toBe(join('/data', 'worktrees'))
  })

  it('creates the root with private mode and returns the worktree service', () => {
    const data = tempDir()
    const root = join(data, 'worktrees')
    const resolved = resolveWorktrees({ ledger: null, dataDir: () => data }, root)
    expect(resolved.ok).toBe(true)
    expect(statSync(root).isDirectory()).toBe(true)
    expect(statSync(root).mode & 0o777).toBe(0o700)
  })

  it('passes an injected service through without touching the filesystem', () => {
    const worktrees = { list: () => [] } as unknown as WorktreeService
    const resolved = resolveWorktrees({ ledger: null, worktrees }, '/nonexistent/never-created')
    expect(resolved.ok).toBe(true)
    if (resolved.ok) expect(resolved.worktrees).toBe(worktrees)
  })

  it('answers a sanitized 500 when the root cannot be created', () => {
    const data = tempDir()
    const blocker = join(data, 'not-a-dir')
    writeFileSync(blocker, 'x')
    const resolved = resolveWorktrees({ ledger: null, dataDir: () => blocker }, join(blocker, 'worktrees'))
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) {
      expect(resolved.result).toEqual({
        status: 500,
        body: {
          ok: false,
          error: { code: 'worktree_root_failed', message: 'worktree root is unavailable' },
        },
      })
      expect(JSON.stringify(resolved.result.body)).not.toContain(data)
    }
  })
})
