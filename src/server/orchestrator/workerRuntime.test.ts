// Test runtime worker P3 memakai fake yang sudah ada (orc/ledger/worktree) plus port sesi,
// verifier, jam, dan tidur palsu. Tidak ada git/PTY nyata di sini.
import { describe, expect, it } from 'vitest'
import { isSafeNodeId, isSafeSessionId } from '../../shared/workspace'
import type { AgentStatus } from '../../shared/workspace'
import type { OpenMsg, ServerMsg } from '../../shared/protocol'
import { PROJECT, REPO, item, planOf, setup } from './orchestrator.fake.testutil'
import type { VerifyOutcome } from './verify'
import type { OrchestratorResult, StartWorkerValue } from './orchestratorModel'
import {
  createSessionsPort,
  createWorkerRuntime,
  deriveNodeId,
  type SessionsLike,
  type WorkerOrchestratorPort,
  type WorkerRunOutcome,
  type WorkerRuntimeDeps,
  type WorkerSessionPort,
} from './workerRuntime'

const CMD = 'agent-cmd'
const AGENT = 'claude'

function assigned() {
  const fixture = setup(planOf([item()]))
  const result = fixture.orchestrator.assignTask({
    projectId: PROJECT,
    itemId: 'i1',
    assignee: 'w1',
    expectedVersion: 1,
  })
  expect(result.ok).toBe(true)
  return fixture
}

function verdict(patch: Partial<VerifyOutcome> = {}): VerifyOutcome {
  return {
    ok: true,
    reasons: [],
    evidence: [
      {
        command: 'npm test',
        exitCode: 0,
        durationMs: 5,
        outputDigest: 'a'.repeat(64),
        summary: 'exit 0 · 1 lines',
      },
    ],
    changedFiles: ['src/api.ts'],
    scopeViolations: [],
    tests: { passed: 3, failed: 0, command: 'npm test' },
    typecheck: { ok: true, command: 'npm run typecheck' },
    ...patch,
  }
}

interface FakeSessions extends WorkerSessionPort {
  opened: { nodeId: string; cwd: string; cmd?: string; agentId?: string; sessionId?: string }[]
  inputs: { nodeId: string; text: string }[]
  closed: string[]
  live: Set<string>
  status: Map<string, AgentStatus>
  terminal: Map<string, string>
  failOpen: boolean
  failInput: boolean
  onInput?: (nodeId: string) => void
  onStatus?: (nodeId: string) => void
}

function fakeSessions(): FakeSessions {
  const fake: FakeSessions = {
    opened: [],
    inputs: [],
    closed: [],
    live: new Set<string>(),
    status: new Map<string, AgentStatus>(),
    terminal: new Map<string, string>(),
    failOpen: false,
    failInput: false,
    open(input) {
      if (fake.failOpen) throw new Error('pty spawn refused')
      fake.opened.push(input)
      fake.live.add(input.nodeId)
    },
    input(nodeId, text) {
      if (fake.failInput) throw new Error('pty write failed')
      fake.inputs.push({ nodeId, text })
      fake.onInput?.(nodeId)
    },
    statusOf: (nodeId) => {
      fake.onStatus?.(nodeId)
      return fake.status.get(nodeId)
    },
    getTerminal: (nodeId) => fake.terminal.get(nodeId) ?? '',
    isLive: (nodeId) => fake.live.has(nodeId),
    close(nodeId) {
      fake.live.delete(nodeId)
      fake.closed.push(nodeId)
    },
  }
  return fake
}

function clock(start = 1000) {
  const state = { at: start }
  return {
    now: () => state.at,
    sleep: async (ms: number) => {
      state.at += ms
    },
  }
}

interface Harness {
  runtime: ReturnType<typeof createWorkerRuntime>
  sessions: FakeSessions
  verifyInputs: { cwd: string; scope?: readonly string[] }[]
}

function harness(
  options: {
    fixture?: ReturnType<typeof assigned>
    orchestrator?: WorkerOrchestratorPort
    verify?: (input: { cwd: string; scope?: readonly string[] }) => Promise<VerifyOutcome>
    runtime?: Partial<WorkerRuntimeDeps>
  } = {}
): Harness {
  const fixture = options.fixture ?? assigned()
  const sessions = fakeSessions()
  const time = clock()
  const verifyInputs: Harness['verifyInputs'] = []
  const deps: WorkerRuntimeDeps = {
    orchestrator: options.orchestrator ?? fixture.orchestrator,
    sessions,
    worktrees: fixture.worktrees,
    cmd: CMD,
    agentId: AGENT,
    now: time.now,
    sleep: time.sleep,
    pollMs: 100,
    timeoutMs: 10_000,
    verify: async (input) => {
      verifyInputs.push(input)
      return options.verify ? options.verify(input) : verdict()
    },
    ...options.runtime,
  }
  return { runtime: createWorkerRuntime(deps), sessions, verifyInputs }
}

function runInput(timeoutMs = 10_000) {
  return { projectId: PROJECT, itemId: 'i1', expectedVersion: 2, repo: REPO, timeoutMs }
}

function expectClosed(sessions: FakeSessions, outcome: WorkerRunOutcome): void {
  expect(outcome.nodeId).not.toBeNull()
  expect(sessions.closed).toContain(outcome.nodeId)
}

describe('runTask success path', () => {
  it('spawns in the worktree, sends a bounded prompt, verifies, and records once', async () => {
    const fixture = assigned()
    let recorded = 0
    const orchestrator: WorkerOrchestratorPort = {
      startWorker: (input) => fixture.orchestrator.startWorker(input),
      recordWorkerResult: (input) => {
        recorded += 1
        return fixture.orchestrator.recordWorkerResult(input)
      },
    }
    const { runtime, sessions, verifyInputs } = harness({ fixture, orchestrator })
    sessions.onInput = (nodeId) => sessions.status.set(nodeId, 'done')
    const outcome = await runtime.runTask(runInput())
    expect(outcome.ok).toBe(true)
    expect(outcome.error).toBeUndefined()
    expect(outcome.task?.status).toBe('verified')
    expect(outcome.plan?.items[0]?.status).toBe('done')
    expect(outcome.nodeId).not.toBeNull()
    expect(isSafeNodeId(outcome.nodeId)).toBe(true)
    expect(recorded).toBe(1)
    expect(sessions.opened).toHaveLength(1)
    expect(sessions.opened[0]).toMatchObject({ cwd: '/tmp/wt/t1', cmd: CMD, agentId: AGENT })
    // Sesi baru wajib dikirim supaya launchLine bisa memasang hooks/`--settings`; id harus aman
    // untuk masuk baris perintah shell.
    const sessionId = sessions.opened[0]?.sessionId
    expect(sessionId).toBeTruthy()
    expect(isSafeSessionId(sessionId, true)).toBe(true)
    const prompt = sessions.inputs[0]?.text ?? ''
    expect(prompt).toContain('/tmp/wt/t1')
    expect(prompt).toContain('agent/t1')
    expect(prompt).toContain('src/api.ts')
    expect(prompt.endsWith('\n')).toBe(true)
    expect(verifyInputs).toEqual([{ cwd: '/tmp/wt/t1', scope: ['src/api.ts'] }])
    expect(outcome.evidence?.tests).toMatchObject({ passed: 3, failed: 0 })
    expect(fixture.worktrees.releases).toEqual(['t1'])
    expectClosed(sessions, outcome)
    expect(fixture.ledger.events.filter((e) => e.kind === 'orchestrator.result_recorded')).toHaveLength(1)
  })
})

describe('failure paths', () => {
  it('fails when the verifier reports no changed files, even with green checks', async () => {
    const fixture = assigned()
    const { runtime, sessions } = harness({
      fixture,
      verify: async () => verdict({ changedFiles: [] }),
    })
    sessions.onInput = (nodeId) => sessions.status.set(nodeId, 'done')
    const outcome = await runtime.runTask(runInput())
    expect(outcome.ok).toBe(false)
    expect(outcome.error?.code).toBe('verify_failed')
    expect(outcome.error?.message).toContain('no files changed')
    expect(outcome.evidence?.tests).toMatchObject({ passed: 3, failed: 0 })
    expect(outcome.task?.status).not.toBe('verified')
    expect(outcome.task?.status).toBe('failed')
    expect(outcome.plan?.items[0]?.status).toBe('failed')
    expect(fixture.ledger.events.filter((e) => e.kind === 'orchestrator.result_recorded')).toHaveLength(1)
    expectClosed(sessions, outcome)
  })

  it('fails the task and plan when the verifier rejects the worktree', async () => {
    const fixture = assigned()
    const { runtime, sessions, verifyInputs } = harness({
      fixture,
      verify: async () => verdict({ ok: false, reasons: ['npm test exited 1'] }),
    })
    sessions.onInput = (nodeId) => sessions.status.set(nodeId, 'done')
    const outcome = await runtime.runTask(runInput())
    expect(outcome.ok).toBe(false)
    expect(outcome.error?.code).toBe('verify_failed')
    expect(outcome.error?.message).toContain('npm test exited 1')
    expect(outcome.task?.status).toBe('failed')
    expect(outcome.plan?.items[0]?.status).toBe('failed')
    expect(verifyInputs).toHaveLength(1)
    expect(fixture.worktrees.releases).toEqual(['t1'])
    expectClosed(sessions, outcome)
  })

  it('fails when the verifier produces no machine evidence', async () => {
    const fixture = assigned()
    const { runtime, sessions } = harness({
      fixture,
      verify: async () =>
        verdict({ tests: undefined, evidence: [], reasons: [], typecheck: undefined }),
    })
    sessions.onInput = (nodeId) => sessions.status.set(nodeId, 'done')
    const outcome = await runtime.runTask(runInput())
    expect(outcome.error?.code).toBe('verify_failed')
    expect(outcome.error?.message).toContain('no machine evidence')
    expect(outcome.task?.status).toBe('failed')
  })

  it('fails on timeout, keeps capped output, and cleans up', async () => {
    const fixture = assigned()
    const { runtime, sessions } = harness({ fixture })
    sessions.terminal.set(deriveNodeId('t1', 1), '\u001b[31m' + 'x'.repeat(400))
    const outcome = await runtime.runTask(runInput(500))
    expect(outcome.ok).toBe(false)
    expect(outcome.error?.code).toBe('timeout')
    expect(outcome.task?.status).toBe('failed')
    expect(fixture.worktrees.releases).toEqual(['t1'])
    expectClosed(sessions, outcome)
    expect(outcome.output).not.toContain('\u001b')
    expect(Buffer.byteLength(outcome.output, 'utf8')).toBeLessThanOrEqual(64 * 1024)
  })

  it('fails when the session exits before reporting done', async () => {
    const fixture = assigned()
    const { runtime, sessions } = harness({ fixture })
    sessions.onInput = (nodeId) => {
      sessions.status.delete(nodeId)
      sessions.live.delete(nodeId)
    }
    const outcome = await runtime.runTask(runInput())
    expect(outcome.error?.code).toBe('session_exited')
    expect(outcome.task?.status).toBe('failed')
    expect(fixture.worktrees.releases).toEqual(['t1'])
    expectClosed(sessions, outcome)
  })

  it('fails on lease expiry before timeout', async () => {
    const fixture = assigned()
    const { runtime, sessions } = harness({ fixture })
    const outcome = await runtime.runTask(runInput(900_000))
    expect(outcome.error?.code).toBe('lease_expired')
    expect(outcome.task?.status).toBe('failed')
    expect(sessions.closed).toContain(outcome.nodeId)
  })

  it('reports a spawn error and never records a live session', async () => {
    const fixture = assigned()
    const { runtime, sessions } = harness({ fixture })
    sessions.failOpen = true
    const outcome = await runtime.runTask(runInput())
    expect(outcome.ok).toBe(false)
    expect(outcome.error?.code).toBe('spawn_failed')
    expect(outcome.error?.message).toContain('pty spawn refused')
    expect(outcome.task?.status).toBe('failed')
    expect(sessions.inputs).toHaveLength(0)
    expect(fixture.worktrees.releases).toEqual(['t1'])
    expect(sessions.closed).toHaveLength(0)
  })

  it('closes the PTY and releases the worktree when the session port throws after open', async () => {
    // Regression C1: `statusOf` lives outside the old spawn try. A throw there used to escape
    // `runTask` with the PTY open and the worktree still held; it must become one recorded
    // failure plus close + release instead.
    const fixture = assigned()
    let recorded = 0
    const orchestrator: WorkerOrchestratorPort = {
      startWorker: (input) => fixture.orchestrator.startWorker(input),
      recordWorkerResult: (input) => {
        recorded += 1
        return fixture.orchestrator.recordWorkerResult(input)
      },
    }
    const { runtime, sessions } = harness({ fixture, orchestrator })
    sessions.onStatus = () => {
      throw new Error('session port broke after open')
    }
    const outcome = await runtime.runTask(runInput())
    expect(outcome.ok).toBe(false)
    expect(outcome.error?.code).toBe('spawn_failed')
    expect(outcome.error?.message).toContain('session port broke after open')
    // Exactly one failure record, one PTY close of OUR node, one release of OUR worktree.
    expect(recorded).toBe(1)
    expect(outcome.task?.status).toBe('failed')
    expect(sessions.closed).toEqual(['w-t1-1'])
    expect(fixture.worktrees.releases).toEqual(['t1'])
    expect(fixture.ledger.events.filter((e) => e.kind === 'orchestrator.result_recorded')).toHaveLength(1)
  })

})

describe('spawn gating and stale fences', () => {
  it('denies a cap violation before opening any session or worktree', async () => {
    const denied: OrchestratorResult<StartWorkerValue> = {
      ok: false,
      code: 'cap_denied',
      message: 'caps blocked worker start: attempts',
    }
    const orchestrator: WorkerOrchestratorPort = {
      startWorker: async () => denied,
      recordWorkerResult: async () => {
        throw new Error('record must not run when startWorker denies')
      },
    }
    const { runtime, sessions } = harness({ orchestrator })
    const outcome = await runtime.runTask(runInput())
    expect(outcome.ok).toBe(false)
    expect(outcome.error?.code).toBe('cap_denied')
    expect(outcome.task).toBeNull()
    expect(sessions.opened).toHaveLength(0)
    expect(sessions.closed).toHaveLength(0)
  })

  it('refuses a stale fence without recording and without releasing the shared worktree', async () => {
    const fixture = assigned()
    const { runtime, sessions } = harness({ fixture })
    sessions.onInput = (nodeId) => {
      const task = fixture.ledger.tasks.get('t1')
      expect(task).toBeDefined()
      if (task) task.fence += 1 // attempt lain mengambil alih tepat sebelum record
      sessions.status.set(nodeId, 'done')
    }
    const outcome = await runtime.runTask(runInput())
    expect(outcome.ok).toBe(false)
    expect(outcome.error?.code).toBe('stale_fence')
    expect(outcome.task?.status).not.toBe('verified')
    expect(fixture.ledger.events.filter((e) => e.kind === 'orchestrator.result_recorded')).toHaveLength(0)
    expect(fixture.worktrees.releases).toEqual([])
    // PTY milik kita tetap ditutup meski ledger menolak hasil.
    expectClosed(sessions, outcome)
  })

  it('survives a throwing ledger record and still cleans up', async () => {
    const fixture = assigned()
    let attempts = 0
    const orchestrator: WorkerOrchestratorPort = {
      startWorker: (input) => fixture.orchestrator.startWorker(input),
      recordWorkerResult: async () => {
        attempts += 1
        throw new Error('lease lost before failTask')
      },
    }
    const { runtime, sessions } = harness({ fixture, orchestrator })
    sessions.onInput = (nodeId) => sessions.status.set(nodeId, 'done')
    const outcome = await runtime.runTask(runInput())
    expect(outcome.ok).toBe(false)
    expect(outcome.error?.code).toBe('lease_denied')
    expect(attempts).toBe(1)
    expect(fixture.worktrees.releases).toEqual(['t1'])
    expectClosed(sessions, outcome)
  })

  it('derives a safe deterministic node id from task and fence', () => {
    const id = deriveNodeId('t1', 3)
    expect(id).toBe('w-t1-3')
    expect(isSafeNodeId(id)).toBe(true)
    expect(isSafeNodeId(deriveNodeId('bad id/../../x', 1))).toBe(true)
    expect(deriveNodeId('t1', 3)).not.toBe(deriveNodeId('t1', 4))
  })
})

describe('bounded input and output', () => {
  it('caps the terminal output to maxOutputBytes', async () => {
    const fixture = assigned()
    const { runtime, sessions } = harness({
      fixture,
      runtime: { maxOutputBytes: 128 },
    })
    sessions.onInput = (nodeId) => sessions.status.set(nodeId, 'done')
    sessions.terminal.set(deriveNodeId('t1', 1), 'y'.repeat(5000))
    const outcome = await runtime.runTask(runInput())
    expect(outcome.ok).toBe(true)
    expect(Buffer.byteLength(outcome.output, 'utf8')).toBeLessThanOrEqual(128)
  })

  it('caps the prompt to maxPromptBytes including extra instructions', async () => {
    const fixture = assigned()
    const { runtime, sessions } = harness({ fixture, runtime: { maxPromptBytes: 200 } })
    sessions.onInput = (nodeId) => sessions.status.set(nodeId, 'done')
    const outcome = await runtime.runTask({ ...runInput(), prompt: 'z'.repeat(5000) })
    expect(outcome.ok).toBe(true)
    const sent = sessions.inputs[0]?.text ?? ''
    expect(Buffer.byteLength(sent, 'utf8')).toBeLessThanOrEqual(201)
  })
})

describe('session id minting', () => {
  it('uses the injected newSessionId once per run when an agent is set', async () => {
    const fixture = assigned()
    let minted = 0
    const { runtime, sessions } = harness({
      fixture,
      runtime: {
        newSessionId: () => {
          minted += 1
          return `sess-fixed-${minted}`
        },
      },
    })
    sessions.onInput = (nodeId) => sessions.status.set(nodeId, 'done')
    const outcome = await runtime.runTask(runInput())
    expect(outcome.ok).toBe(true)
    expect(minted).toBe(1)
    expect(sessions.opened[0]?.sessionId).toBe('sess-fixed-1')
  })
})

describe('createSessionsPort', () => {
  it('maps the port calls onto the sessions surface without a PTY', () => {
    const opened: OpenMsg[] = []
    const closed: string[] = []
    const sent: ServerMsg[] = []
    const source: SessionsLike = {
      open: (msg, send) => {
        opened.push(msg)
        send({ t: 'status', id: msg.id })
      },
      input: () => {},
      statusOf: () => 'working',
      getTerminal: () => 'screen',
      isLive: () => true,
      close: (id) => closed.push(id),
    }
    const port = createSessionsPort(source)

    port.open({ nodeId: 'w-t1-1', cwd: '/tmp/wt/t1', cmd: CMD, sessionId: 'sess-abc' })
    expect(opened[0]).toMatchObject({
      t: 'open',
      id: 'w-t1-1',
      cols: 120,
      rows: 40,
      cmd: CMD,
      sessionId: 'sess-abc',
    })
    expect(port.statusOf('w-t1-1')).toBe('working')
    expect(port.getTerminal('w-t1-1')).toBe('screen')
    expect(port.isLive('w-t1-1')).toBe(true)
    port.close('w-t1-1')
    expect(closed).toEqual(['w-t1-1'])
    expect(sent).toEqual([])
  })
})
