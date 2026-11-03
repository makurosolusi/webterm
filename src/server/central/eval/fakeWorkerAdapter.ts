// Eval worker driver (RND/29-b §4.13 `fakeWorkers`): scripted worker behaviours on top of the
// shared orchestrator fake (`orchestrator.fake.testutil.ts`, reused untouched). No process, no git.
import {
  PROJECT, REPO, item, planOf, setup, worker, type Fixture,
} from '../../orchestrator/orchestrator.fake.testutil'
import {
  SERVER_VERIFIED_BY, type OrchestratorDenyCode, type VerificationEvidence,
} from '../../orchestrator/orchestratorModel'
import type { Plan } from '../../orchestrator/plan'

/** success: server-verified evidence; failure: reported failure; hang: never reports; forged: claims done without the server marker. */
export type FakeWorkerMode = 'success' | 'failure' | 'hang' | 'forged'

export interface FakeWorkerRun {
  itemId: string
  taskId: string
  mode: FakeWorkerMode
  taskStatus: string
  itemStatus: string
  /** True only when the orchestrator accepted the evidence as server-verified. */
  verified: boolean
}

export interface FakeWorkers {
  fixture: Fixture
  /** Drives the next pending item through assign, start and the scripted outcome. */
  run(mode: FakeWorkerMode): Promise<FakeWorkerRun>
}

const WORKER_ID = 'w1'

/** Evidence the real verifier would produce for a green worktree (test-only literals). */
const GREEN_EVIDENCE: VerificationEvidence = { verifiedBy: SERVER_VERIFIED_BY, tests: { passed: 1, failed: 0 } }

function denied(step: string, code: OrchestratorDenyCode, message: string): Error {
  return new Error(`fake worker ${step} denied (${code}): ${message}`)
}

/** `itemCount` pending items i1..iN, one idle worker `w1`. */
export function createFakeWorkers(itemCount = 1): FakeWorkers {
  const items = Array.from({ length: itemCount }, (_, index) => item({ id: `i${index + 1}`, seq: index }))
  const fixture = setup(planOf(items), [worker(WORKER_ID)])
  let plan: Plan = planOf(items)
  let next = 0

  async function run(mode: FakeWorkerMode): Promise<FakeWorkerRun> {
    const itemId = items[next]?.id
    if (itemId === undefined) throw new Error(`fake worker: no pending item left (${itemCount} used)`)
    next += 1
    const assigned = fixture.orchestrator.assignTask({
      projectId: PROJECT, itemId, assignee: WORKER_ID, expectedVersion: plan.version,
    })
    if (!assigned.ok) throw denied('assign', assigned.code, assigned.message)
    plan = assigned.value.plan
    const started = await fixture.orchestrator.startWorker({
      projectId: PROJECT, itemId, expectedVersion: plan.version, repo: REPO,
    })
    if (!started.ok) throw denied('start', started.code, started.message)
    plan = started.value.plan
    const taskId = started.value.task.id
    if (mode === 'hang') return snapshot(itemId, taskId, mode, false)
    const reported = await fixture.orchestrator.recordWorkerResult({
      projectId: PROJECT, taskId, fence: started.value.task.fence, actor: WORKER_ID, itemId,
      expectedVersion: plan.version,
      outcome: mode === 'failure' ? 'failure' : 'success',
      ...(mode === 'failure' ? { reason: 'scripted failure' } : {}),
      // ponytail: `forged` casts away the marker on purpose; the type system is not the trust boundary.
      ...(mode === 'forged' ? { evidence: { tests: { passed: 1, failed: 0 } } as unknown as VerificationEvidence } : {}),
      ...(mode === 'success' ? { evidence: GREEN_EVIDENCE } : {}),
    })
    if (!reported.ok) throw denied('record', reported.code, reported.message)
    plan = reported.value.plan
    return snapshot(itemId, taskId, mode, reported.value.verified)
  }

  function snapshot(itemId: string, taskId: string, mode: FakeWorkerMode, verified: boolean): FakeWorkerRun {
    return {
      itemId, taskId, mode, verified,
      taskStatus: fixture.ledger.tasks.get(taskId)?.status ?? 'missing',
      itemStatus: plan.items.find((candidate) => candidate.id === itemId)?.status ?? 'missing',
    }
  }

  return { fixture, run }
}
