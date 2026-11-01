import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SERVER_VERIFIED_BY,
  type OrchestratorTask,
  type VerificationEvidence as ModelEvidence,
} from './orchestratorModel'
import type { VerifyInput, VerifyOutcome } from './verify'
import {
  cleanEnv,
  parseChangedFiles,
  parseNameOnly,
  toModelEvidence,
  verifyHomeDir,
  verifyWorkerResult,
} from './verifier'

const PROJECT = 'p1'

function task(patch: Partial<OrchestratorTask> = {}): OrchestratorTask {
  return {
    id: 't1',
    projectId: PROJECT,
    agentId: 'w1',
    status: 'claimed_done',
    fence: 2,
    leaseOwner: 'w1',
    leaseExpires: 1000,
    attempt: 1,
    maxAttempts: 3,
    evidence: { workerClaim: 'tests passed' },
    ...patch,
  }
}

function outcome(patch: Partial<VerifyOutcome> = {}): VerifyOutcome {
  return {
    verifiedBy: SERVER_VERIFIED_BY,
    ok: true,
    reasons: [],
    evidence: [
      {
        command: 'npm test',
        exitCode: 0,
        durationMs: 10,
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

function fixture(initial: OrchestratorTask, verdict: VerifyOutcome | Error = outcome()) {
  const state = { task: initial }
  const events: { kind: string; payload?: unknown; actor: string }[] = []
  const verifiedWith: { fence: number; evidence: unknown }[] = []
  const verifyInputs: VerifyInput[] = []
  const ledger = {
    task: {
      getTask: (id: string) => (id === state.task.id ? { ...state.task } : null),
      verifyTask: (id: string, fence: number, evidence: unknown) => {
        if (id !== state.task.id) throw new Error(`no task ${id}`)
        if (fence !== state.task.fence) throw new Error('stale fence')
        verifiedWith.push({ fence, evidence })
        state.task = { ...state.task, status: 'verified', evidence }
        return { ...state.task }
      },
      createTask: () => {
        throw new Error('unused')
      },
      leaseTask: () => {
        throw new Error('unused')
      },
      claimDone: () => {
        throw new Error('unused')
      },
      failTask: () => {
        throw new Error('unused')
      },
    },
    event: {
      appendEvent: (event: { kind: string; actor: string; payload?: unknown }) => {
        events.push({ kind: event.kind, actor: event.actor, payload: event.payload })
        return null
      },
    },
  }
  const deps = {
    ledger,
    verify: async (input: VerifyInput) => {
      verifyInputs.push(input)
      if (verdict instanceof Error) throw verdict
      return verdict
    },
  }
  return { deps, state, events, verifiedWith, verifyInputs }
}

const request = {
  projectId: PROJECT,
  taskId: 't1',
  fence: 2,
  actor: 'w1',
  cwd: '/tmp/wt/task-1',
  scope: ['src/api.ts'],
}

describe('git porcelain parsers', () => {
  it('uses the new path for renames and unquotes paths', () => {
    expect(parseChangedFiles('R  src/old.ts -> src/new.ts\n M "src/with space.ts"\n')).toEqual([
      'src/new.ts',
      'src/with space.ts',
    ])
    expect(parseNameOnly('src/a.ts\n\n')).toEqual(['src/a.ts'])
  })
})

describe('verifyWorkerResult', () => {
  it('moves claimed_done to verified using server evidence, not the worker claim', async () => {
    const ctx = fixture(task())
    const result = await verifyWorkerResult(ctx.deps, request)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.verified).toBe(true)
    expect(result.value.task.status).toBe('verified')
    expect(ctx.verifyInputs).toEqual([{ cwd: request.cwd, scope: request.scope, checks: undefined }])
    expect(ctx.verifiedWith).toHaveLength(1)
    const evidence = ctx.verifiedWith[0]?.evidence as ModelEvidence & { commands: unknown[] }
    expect(evidence.tests).toEqual({ passed: 3, failed: 0, command: 'npm test' })
    expect(evidence.verifiedBy).toBe(SERVER_VERIFIED_BY)
    expect(evidence.scopeViolations).toEqual([])
    expect(evidence.commands).toHaveLength(1)
    expect(evidence).not.toMatchObject({ workerClaim: 'tests passed' })
    expect(ctx.events.map((event) => event.kind)).toEqual(['orchestrator.verified'])
  })

  it('keeps claimed_done and audits reasons when verification fails', async () => {
    const ctx = fixture(task(), outcome({ ok: false, reasons: ['npm test exited 1'] }))
    const result = await verifyWorkerResult(ctx.deps, request)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.verified).toBe(false)
    expect(result.value.task.status).toBe('claimed_done')
    expect(ctx.verifiedWith).toHaveLength(0)
    expect(ctx.events.map((event) => event.kind)).toEqual(['orchestrator.verify_failed'])
    expect(ctx.events[0]?.payload).toMatchObject({ reasons: ['npm test exited 1'] })
  })

  it('rejects a verdict without test evidence even if the verifier says ok', async () => {
    const ctx = fixture(task(), outcome({ tests: undefined }))
    const result = await verifyWorkerResult(ctx.deps, request)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.verified).toBe(false)
    expect(ctx.verifiedWith).toHaveLength(0)
    expect(ctx.events.map((event) => event.kind)).toEqual(['orchestrator.verify_failed'])
  })

  it('rejects claimed_done without any claimed evidence', async () => {
    const ctx = fixture(task({ evidence: null }))
    const result = await verifyWorkerResult(ctx.deps, request)

    expect(result).toMatchObject({ ok: false, code: 'invalid_state' })
    expect(ctx.verifyInputs).toHaveLength(0)
  })

  it('rejects a task that has not claimed done yet', async () => {
    const ctx = fixture(task({ status: 'leased' }))
    const result = await verifyWorkerResult(ctx.deps, request)

    expect(result).toMatchObject({ ok: false, code: 'invalid_state' })
    expect(ctx.verifyInputs).toHaveLength(0)
  })

  it('rejects a stale fence before running any command', async () => {
    const ctx = fixture(task({ fence: 3 }))
    const result = await verifyWorkerResult(ctx.deps, request)

    expect(result).toMatchObject({ ok: false, code: 'stale_fence' })
    expect(ctx.verifyInputs).toHaveLength(0)
  })

  it('rejects a task outside the project and a missing task', async () => {
    const foreign = fixture(task({ projectId: 'p2' }))
    expect(await verifyWorkerResult(foreign.deps, request)).toMatchObject({
      ok: false,
      code: 'project_mismatch',
    })

    const missing = fixture(task({ id: 'other' }))
    expect(await verifyWorkerResult(missing.deps, { ...request, taskId: 't1' })).toMatchObject({
      ok: false,
      code: 'task_not_found',
    })
  })

  it('propagates verifier infrastructure errors instead of verifying', async () => {
    const ctx = fixture(task(), new Error('exec unavailable'))
    await expect(verifyWorkerResult(ctx.deps, request)).rejects.toThrow('exec unavailable')
    expect(ctx.verifiedWith).toHaveLength(0)
  })

  it('refuses to convert a verdict that did not come from verifyWorktree', () => {
    // Worker path: a hand-built outcome has no server marker, so it never becomes model evidence.
    const forged = { ...outcome(), verifiedBy: undefined } as unknown as VerifyOutcome
    expect(() => toModelEvidence(forged)).toThrow(/verifyWorktree/)
  })
})

describe('cleanEnv (M4)', () => {
  it('never inherits HOME or credential variables from the server process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'webterm-verify-home-'))
    const env = cleanEnv(
      {
        PATH: '/usr/bin',
        LANG: 'en_US.UTF-8',
        HOME: '/home/operator',
        TMPDIR: '/tmp/operator',
        AWS_SECRET_ACCESS_KEY: 'aws-secret',
        GITHUB_TOKEN: 'gh-token',
        NPM_TOKEN: 'npm-token',
        NODE_OPTIONS: '--require /tmp/evil.js',
      },
      { home: dir }
    )
    expect(env.HOME).toBe(dir)
    expect(env.TMPDIR).toBe(dir)
    expect(env.PATH).toBe('/usr/bin')
    expect(env.LANG).toBe('en_US.UTF-8')
    for (const leaked of ['/home/operator', '/tmp/operator', 'aws-secret', 'gh-token', 'npm-token', 'evil.js']) {
      expect(JSON.stringify(env)).not.toContain(leaked)
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('uses a private 0700 scratch home by default', () => {
    const home = verifyHomeDir()
    expect(home).toBe(join(tmpdir(), 'webterm-verify-home'))
    expect(statSync(home).mode & 0o077).toBe(0)
    expect(cleanEnv({ PATH: '/usr/bin' }).HOME).toBe(home)
  })
})
