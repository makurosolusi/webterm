import { describe, expect, it } from 'vitest'
import type { AgentStatus } from '../../shared/workspace'
import type { WorkerSessionPort } from './workerRuntimeSession'
import { candidateDone, DEFAULT_IDLE_DONE_MS, idleDoneMs, withCandidateSignal, type GitProbe } from './workerSignal'

const THRESHOLD = 1_000

function harness(git: { dirty?: string; head?: string } = {}) {
  let clock = 0
  let output = 'booting'
  let status: AgentStatus | undefined = 'working'
  const state = { dirty: git.dirty ?? '', head: git.head ?? 'aaa' }
  const closed: string[] = []
  const inner: WorkerSessionPort = {
    open: () => {},
    input: () => {},
    submit: async () => ({ ok: true as const, started: true as const }),
    statusOf: () => status,
    getTerminal: () => output,
    isLive: () => true,
    close: (id) => void closed.push(id),
  }
  const calls: string[] = []
  const probe: GitProbe = async (_cwd, args) => {
    calls.push(args.join(' '))
    return { code: 0, stdout: args[0] === 'status' ? state.dirty : state.head }
  }
  const port = withCandidateSignal(inner, { thresholdMs: THRESHOLD, probe, now: () => clock })
  return {
    port,
    state,
    calls,
    closed,
    advance: (ms: number) => void (clock += ms),
    setOutput: (text: string) => void (output = text),
    setStatus: (next: AgentStatus | undefined) => void (status = next),
    flush: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  }
}

describe('candidateDone', () => {
  it('needs both idle time and a diff', () => {
    expect(candidateDone({ idleMs: 999, thresholdMs: 1000, hasDiff: true })).toBe(false)
    expect(candidateDone({ idleMs: 5000, thresholdMs: 1000, hasDiff: false })).toBe(false)
    expect(candidateDone({ idleMs: 1000, thresholdMs: 1000, hasDiff: true })).toBe(true)
  })
})

describe('idleDoneMs', () => {
  it('reads the env within range and falls back to the default otherwise', () => {
    expect(idleDoneMs({ WEBTERM_AGENT_IDLE_DONE_MS: '2500' })).toBe(2500)
    expect(idleDoneMs({})).toBe(DEFAULT_IDLE_DONE_MS)
    expect(idleDoneMs({ WEBTERM_AGENT_IDLE_DONE_MS: '5' })).toBe(DEFAULT_IDLE_DONE_MS)
    expect(idleDoneMs({ WEBTERM_AGENT_IDLE_DONE_MS: 'soon' })).toBe(DEFAULT_IDLE_DONE_MS)
  })
})

describe('withCandidateSignal', () => {
  async function opened(git?: { dirty?: string; head?: string }) {
    const h = harness(git)
    await h.port.open({ nodeId: 'n1', cwd: '/wt/n1' })
    return h
  }

  it('reports done once idle with uncommitted changes, never while output is still moving', async () => {
    const h = await opened({ dirty: ' M src/a.ts' })
    expect(h.port.statusOf('n1')).toBe('working') // first poll records the output signature
    h.advance(THRESHOLD - 1)
    expect(h.port.statusOf('n1')).toBe('working')
    expect(h.calls).not.toContain('status --porcelain')
    h.advance(1)
    expect(h.port.statusOf('n1')).toBe('working') // diff probe is async: not proven yet
    await h.flush()
    expect(h.port.statusOf('n1')).toBe('done')
    h.setOutput('still typing')
    expect(h.port.statusOf('n1')).toBe('working') // new output resets idle and the cached diff
  })

  it('does not report done when idle but the worktree is untouched', async () => {
    const h = await opened()
    h.port.statusOf('n1')
    h.advance(THRESHOLD * 10)
    h.port.statusOf('n1')
    await h.flush()
    expect(h.port.statusOf('n1')).toBe('working')
  })

  it('counts a local commit (HEAD moved) as a diff when the tree is clean', async () => {
    const h = await opened()
    h.state.head = 'bbb'
    h.port.statusOf('n1')
    h.advance(THRESHOLD)
    h.port.statusOf('n1')
    await h.flush()
    expect(h.port.statusOf('n1')).toBe('done')
  })

  it('passes a real done through and forgets the node on close', async () => {
    const h = await opened()
    h.setStatus('done')
    expect(h.port.statusOf('n1')).toBe('done')
    h.setStatus('working')
    h.port.close('n1')
    expect(h.closed).toEqual(['n1'])
    h.advance(THRESHOLD * 10)
    expect(h.port.statusOf('n1')).toBe('working')
    expect(h.calls.filter((c) => c === 'status --porcelain')).toHaveLength(0)
  })
})
