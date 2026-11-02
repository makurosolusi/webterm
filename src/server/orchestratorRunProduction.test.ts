// Focused tests for the server-side composition split out of orchestratorRunApi.
// Route-level behavior stays covered by orchestratorRunApi.test.ts.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Approval } from './ledger/ledgerApproval'
import { approvalDigest } from './ledger/ledgerApproval'
import type { ApprovalPort } from './orchestrator/approvalGate'
import type { PlanItem } from './orchestrator/planModel'
import type { WorktreeService } from './orchestrator/worktree'
import {
  approvalMissing,
  approvalPortOf,
  assignmentProblem,
  guardedRun,
  projectPaused,
  projectRepo,
  resolveWorktrees,
  runItemTaskId,
  worktreeRoot,
} from './orchestratorRunProduction'
import type { RawRun } from './orchestratorRunModel'

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

  it('reports only an exact `paused` status, and null when the project row is missing', () => {
    const row = (value: unknown) => ({ query: () => ({ get: () => value }) })
    expect(projectPaused(row({ status: 'paused' }) as never, 'p1')).toBe(true)
    expect(projectPaused(row({ status: 'active' }) as never, 'p1')).toBe(false)
    expect(projectPaused(row({ status: 'PAUSED' }) as never, 'p1')).toBe(false)
    expect(projectPaused(row({ status: null }) as never, 'p1')).toBe(false)
    expect(projectPaused(row({ path: '/srv/repo' }) as never, 'p1')).toBe(false)
    expect(projectPaused(row(null) as never, 'p1')).toBeNull()
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

  it('reads the run item task and fails closed when it cannot be resolved', () => {
    expect(runItemTaskId(planStore(item()), 'p1', 'i1')).toBe('t1')
    expect(runItemTaskId(planStore(item({ taskId: null })), 'p1', 'i1')).toBeNull()
    expect(runItemTaskId(planStore(item()), 'p1', 'nope')).toBeNull()
    expect(runItemTaskId(planStore(null), 'p1', 'i1')).toBeNull()
    const broken = {
      get: () => {
        throw new Error('db gone')
      },
    }
    expect(runItemTaskId(broken, 'p1', 'i1')).toBeNull()
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

const ACTION = { action: 'worker.run', projectId: 'p1', itemId: 'i1' }
const DIGEST = approvalDigest(ACTION)
const RUN = { projectId: 'p1', itemId: 'i1', expectedVersion: 1, approvalId: 'ap1', approvalDigest: DIGEST }
const OK = { status: 200, body: { ok: true } }

function record(patch: Partial<Approval> = {}): Approval {
  return {
    id: 'ap1',
    projectId: 'p1',
    taskId: 't1',
    kind: 'worker.run',
    request: ACTION,
    status: 'approved',
    approvedBy: 'human',
    expiresAt: null,
    createdAt: 1,
    updatedAt: 2,
    ...patch,
  }
}

/** In-memory approval ledger; consumption is atomic-once like the SQL one. */
function approvalLedger(entry: Approval = record()) {
  const seen: string[] = []
  let consumed = 0
  const port: ApprovalPort = {
    getApproval: (id) => {
      seen.push(`get:${id}`)
      return id === entry.id ? entry : null
    },
    consumeApproval: (id, input) => {
      seen.push(`consume:${input.digest}`)
      if (consumed > 0 || id !== entry.id) return false
      consumed += 1
      return true
    },
  }
  return { port, seen, consumes: () => consumed }
}

describe('orchestratorRunProduction approval port', () => {
  it('prefers an injected port, then the ledger facade, and refuses a partial one', () => {
    const injected = approvalLedger().port
    expect(approvalPortOf({ ledger: null, approval: injected })).toBe(injected)
    const facade = approvalLedger().port
    const runtime = { ledger: { approval: facade } } as never
    expect(approvalPortOf({ ledger: runtime })).toBe(facade)
    expect(approvalPortOf({ ledger: null })).toBeNull()
    expect(approvalPortOf({ ledger: { ledger: { getApproval: () => null } } as never })).toBeNull()
  })

  it('requires approval only when the flag is on and the fields are missing', () => {
    const bare = { projectId: 'p1', itemId: 'i1', expectedVersion: 1 }
    expect(approvalMissing({ ledger: null }, bare)).toBe(false)
    expect(approvalMissing({ ledger: null, requireApproval: true }, bare)).toBe(true)
    expect(approvalMissing({ ledger: null, requireApproval: true }, RUN)).toBe(false)

    process.env['WEBTERM_RUN_REQUIRE_APPROVAL'] = 'on'
    try {
      expect(approvalMissing({ ledger: null }, bare)).toBe(true)
      expect(approvalMissing({ ledger: null, requireApproval: false }, bare)).toBe(false)
    } finally {
      delete process.env['WEBTERM_RUN_REQUIRE_APPROVAL']
    }
  })
})

describe('guardedRun', () => {
  async function gate(
    request: RawRun,
    deps: Parameters<typeof guardedRun>[0],
    expectedTaskId: string | null = 't1'
  ) {
    const calls: string[] = []
    const result = await guardedRun(deps, request, async () => {
      calls.push('run')
      return OK
    }, expectedTaskId)
    return { result, calls }
  }

  it('runs gated work only after consuming the approved digest', async () => {
    const ledger = approvalLedger()
    const { result, calls } = await gate(RUN, { ledger: null, approval: ledger.port })
    expect(result.status).toBe(200)
    expect(calls).toEqual(['run'])
    expect(ledger.consumes()).toBe(1)
    expect(ledger.seen).toEqual(['get:ap1', `consume:${DIGEST}`])
  })

  it('answers 409 approval_required without consuming when the policy is on', async () => {
    const ledger = approvalLedger()
    const request = { projectId: 'p1', itemId: 'i1', expectedVersion: 1 }
    const { result, calls } = await gate(request, {
      ledger: null,
      requireApproval: true,
      approval: ledger.port,
    })
    expect(result.status).toBe(409)
    expect(result.body).toMatchObject({ error: 'approval_required' })
    expect(calls).toEqual([])
    expect(ledger.seen).toEqual([])
  })

  it.each([
    ['pending', record({ status: 'pending' }), 'approval_pending'],
    ['rejected', record({ status: 'rejected' }), 'approval_rejected'],
    ['expired', record({ status: 'expired' }), 'approval_expired'],
  ])('maps a %s decision to 409 and skips the action', async (_label, entry, code) => {
    const ledger = approvalLedger(entry)
    const { result, calls } = await gate(RUN, { ledger: null, approval: ledger.port })
    expect(result).toMatchObject({ status: 409, body: { error: 'approval_rejected', code } })
    expect(calls).toEqual([])
    expect(ledger.consumes()).toBe(0)
  })

  it('treats an elapsed expiry as expired using the injected clock', async () => {
    const ledger = approvalLedger(record({ expiresAt: 1_000 }))
    const live = await gate(RUN, { ledger: null, approval: ledger.port, now: () => 999 })
    expect(live.result.status).toBe(200)
    const stale = approvalLedger(record({ expiresAt: 1_000 }))
    const dead = await gate(RUN, { ledger: null, approval: stale.port, now: () => 1_000 })
    expect(dead.result).toMatchObject({ status: 409, body: { code: 'approval_expired' } })
    expect(dead.calls).toEqual([])
  })

  it('refuses an unknown approval id or a mismatched digest without running', async () => {
    const known = approvalLedger()
    const unknown = await gate({ ...RUN, approvalId: 'nope' }, { ledger: null, approval: known.port })
    expect(unknown.result).toMatchObject({ status: 409, body: { code: 'approval_not_found' } })

    const mismatch = await gate(
      { ...RUN, approvalDigest: 'b'.repeat(64) },
      { ledger: null, approval: known.port }
    )
    expect(mismatch.result).toMatchObject({ status: 409, body: { code: 'approval_digest_mismatch' } })
    expect(JSON.stringify(mismatch.result.body)).not.toContain('b'.repeat(64))
    expect(known.consumes()).toBe(0)
    expect(unknown.calls).toEqual([])
    expect(mismatch.calls).toEqual([])
  })

  it('fails closed when the request names an approval but no port is wired', async () => {
    const { result, calls } = await gate(RUN, { ledger: null })
    expect(result).toMatchObject({ status: 409, body: { code: 'approval_unavailable' } })
    expect(calls).toEqual([])
  })

  it('rejects an approval issued for another project without consuming or running', async () => {
    // Same request/digest as the run, but the approval belongs to `p2`: even a matching digest
    // must not authorize work in another project.
    const ledger = approvalLedger(record({ projectId: 'p2' }))
    const { result, calls } = await gate(RUN, { ledger: null, approval: ledger.port })
    expect(result).toEqual({
      status: 409,
      body: {
        error: 'approval_rejected',
        code: 'approval_project_mismatch',
        message: 'approval does not belong to the requested project',
      },
    })
    expect(calls).toEqual([])
    expect(ledger.consumes()).toBe(0)
    expect(ledger.seen).toEqual(['get:ap1'])
    const body = JSON.stringify(result.body)
    expect(body).not.toContain('ap1')
    expect(body).not.toContain(DIGEST)
  })

  it('treats an unassigned (null) approval project as a mismatch', async () => {
    const ledger = approvalLedger(record({ projectId: null }))
    const { result, calls } = await gate(RUN, { ledger: null, approval: ledger.port })
    expect(result).toMatchObject({
      status: 409,
      body: { error: 'approval_rejected', code: 'approval_project_mismatch' },
    })
    expect(calls).toEqual([])
    expect(ledger.consumes()).toBe(0)
  })

  it('still consumes and runs when the approval belongs to the requested project', async () => {
    const ledger = approvalLedger(record({ projectId: 'p1' }))
    const { result, calls } = await gate(RUN, { ledger: null, approval: ledger.port })
    expect(result).toEqual(OK)
    expect(calls).toEqual(['run'])
    expect(ledger.consumes()).toBe(1)
    expect(ledger.seen).toEqual(['get:ap1', `consume:${DIGEST}`])
  })

  it('rejects a task-bound approval for another task without consuming or running', async () => {
    // Same project, same digest, but the approval was decided for task `t2` while the run item
    // is task `t1`: task isolation must refuse it before the gate consumes anything.
    const ledger = approvalLedger(record({ taskId: 't2' }))
    const { result, calls } = await gate(RUN, { ledger: null, approval: ledger.port }, 't1')
    expect(result).toEqual({
      status: 409,
      body: {
        error: 'approval_rejected',
        code: 'approval_task_mismatch',
        message: 'approval does not belong to the task bound to this plan item',
      },
    })
    expect(calls).toEqual([])
    expect(ledger.consumes()).toBe(0)
    expect(ledger.seen).toEqual(['get:ap1'])
    const body = JSON.stringify(result.body)
    expect(body).not.toContain('ap1')
    expect(body).not.toContain(DIGEST)
  })

  it('fails closed when the run item task cannot be resolved', async () => {
    const ledger = approvalLedger()
    const { result, calls } = await gate(RUN, { ledger: null, approval: ledger.port }, null)
    expect(result).toMatchObject({ status: 409, body: { code: 'approval_task_mismatch' } })
    expect(calls).toEqual([])
    expect(ledger.consumes()).toBe(0)
  })

  it('still runs a generic (taskId=null) approval on any task', async () => {
    const ledger = approvalLedger(record({ taskId: null }))
    const { result, calls } = await gate(RUN, { ledger: null, approval: ledger.port }, 't1')
    expect(result).toEqual(OK)
    expect(calls).toEqual(['run'])
    expect(ledger.consumes()).toBe(1)
    expect(ledger.seen).toEqual(['get:ap1', `consume:${DIGEST}`])
  })

  it('checks project isolation before task isolation', async () => {
    const ledger = approvalLedger(record({ projectId: 'p2', taskId: 't2' }))
    const { result, calls } = await gate(RUN, { ledger: null, approval: ledger.port }, 't1')
    expect(result).toMatchObject({ status: 409, body: { code: 'approval_project_mismatch' } })
    expect(calls).toEqual([])
    expect(ledger.consumes()).toBe(0)
  })

  it('keeps approval_not_found for an unknown id and never runs', async () => {
    const ledger = approvalLedger()
    const { result, calls } = await gate(
      { ...RUN, approvalId: 'missing' },
      { ledger: null, approval: ledger.port }
    )
    expect(result).toMatchObject({ status: 409, body: { code: 'approval_not_found' } })
    expect(calls).toEqual([])
    expect(ledger.consumes()).toBe(0)
  })

  it('answers a sanitized 500 when reading the approval throws', async () => {
    const port: ApprovalPort = {
      getApproval: () => {
        throw new Error(`db gone for ${DIGEST}`)
      },
      consumeApproval: () => true,
    }
    const { result, calls } = await gate(RUN, { ledger: null, approval: port })
    expect(result).toEqual({
      status: 500,
      body: { ok: false, error: { code: 'internal', message: 'orchestrator run failed' } },
    })
    expect(calls).toEqual([])
    expect(JSON.stringify(result.body)).not.toContain(DIGEST)
  })

  it('consumes before the action, so a failing action still burns the approval', async () => {
    const ledger = approvalLedger()
    const result = await guardedRun({ ledger: null, approval: ledger.port }, RUN, async () => {
      throw new Error('boom')
    }, 't1')
    expect(result).toEqual({
      status: 500,
      body: { ok: false, error: { code: 'internal', message: 'orchestrator run failed' } },
    })
    expect(ledger.consumes()).toBe(1)
    expect(JSON.stringify(result.body)).not.toContain('boom')
  })
})
