import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentRecord } from '../contracts'
import { openFixture, seedPortfolio } from '../centralTestFixture.testutil'
import { agentSessionId } from './agentCanvas'
import { type AgentHost, agentNodeId, createAgentExecutor } from './agentExecutor'
import { CONTINUE_PROMPT, repromptContinue, resumeAgent, RESUME_MAX_AGE_MS, transcriptMtime, type ResumeDeps } from './agentSessionResume'

const NOW = 1_700_000_000_000
const agent = { id: 'a1', projectId: 'p1', kind: 'claude', role: 'worker', runner: 'pty', state: 'orphaned', nodeId: 'c-a1' } as unknown as AgentRecord

function deps(over: Partial<ResumeDeps> = {}, rec: AgentRecord | null = agent) {
  const resumePty = vi.fn(async () => undefined)
  const d: ResumeDeps = {
    store: { get: () => rec },
    host: { hasSession: () => false, worktreeOf: () => '/wt/a1', resumePty },
    now: () => NOW, transcript: () => NOW - 60_000, dirExists: () => true, ...over,
  }
  return { d, resumePty }
}

describe('resumeAgent', () => {
  it('launches the same node in the same worktree with the default max age', async () => {
    const { d, resumePty } = deps()
    const res = await resumeAgent(d, 'a1')
    expect(res).toEqual({ ok: true, agentId: 'a1', nodeId: agentNodeId('a1'), sessionId: agentSessionId(agent), cwd: '/wt/a1' })
    expect(resumePty).toHaveBeenCalledWith(agent, '/wt/a1', 'c-a1', RESUME_MAX_AGE_MS)
  })

  const refusals: Array<[string, Partial<ResumeDeps>, AgentRecord | null | 'exec']> = [
    ['no_session_id', {}, null],
    ['no_session_id', {}, 'exec'],
    ['already_live', { host: { hasSession: () => true, worktreeOf: () => '/wt/a1', resumePty: vi.fn() } }, agent],
    ['cwd_missing', { dirExists: () => false }, agent],
    ['cwd_missing', { host: { hasSession: () => false, worktreeOf: () => null, resumePty: vi.fn() } }, agent],
    ['transcript_missing', { transcript: () => null }, agent],
    ['too_old', { transcript: () => NOW - RESUME_MAX_AGE_MS - 1 }, agent],
  ]
  it.each(refusals)('refuses %s without launching anything', async (code, over, rec) => {
    const resumePty = vi.fn()
    const base = over.host ? over : { ...over, host: { hasSession: () => false, worktreeOf: () => '/wt/a1', resumePty } }
    const record = rec === 'exec' ? ({ ...agent, runner: 'exec' } as AgentRecord) : rec
    const { d } = deps(base, record)
    const res = await resumeAgent(d, 'a1')
    expect(res).toMatchObject({ ok: false, code })
    expect(resumePty).not.toHaveBeenCalled()
    expect((d.host.resumePty as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('a custom maxAgeMs bounds the age (exactly at the bound is allowed)', async () => {
    expect((await resumeAgent(deps({ transcript: () => NOW - 5_000 }).d, 'a1', { maxAgeMs: 5_000 })).ok).toBe(true)
    expect(await resumeAgent(deps({ transcript: () => NOW - 5_001 }).d, 'a1', { maxAgeMs: 5_000 })).toMatchObject({ code: 'too_old' })
  })

  it('a spawn refusal becomes launch_failed with context', async () => {
    const { d } = deps()
    d.host = { ...d.host, resumePty: async () => { throw new Error('spawn_depth_exceeded: nope') } }
    const res = await resumeAgent(d, 'a1')
    expect(res).toMatchObject({ ok: false, code: 'launch_failed' })
    expect(res.ok === false && res.message).toContain('spawn_depth_exceeded')
  })
})

describe('transcriptMtime: no symlinks, nothing outside the root', () => {
  const sid = agentSessionId(agent) as string
  const setup = () => {
    const base = mkdtempSync(join(tmpdir(), 'resume-tr-'))
    const root = join(base, 'projects')
    mkdirSync(join(root, 'proj'), { recursive: true })
    return { base, root }
  }
  it('finds a regular transcript and reports its mtime', () => {
    const { root } = setup()
    const file = join(root, 'proj', `${sid}.jsonl`)
    writeFileSync(file, '{}\n')
    utimesSync(file, 1_000, 1_000)
    expect(transcriptMtime(sid, root)).toBe(1_000_000)
  })
  it('refuses a symlinked transcript, even one pointing inside the root', () => {
    const { base, root } = setup()
    writeFileSync(join(root, 'proj', 'real.jsonl'), '{}\n')
    symlinkSync(join(root, 'proj', 'real.jsonl'), join(root, 'proj', `${sid}.jsonl`))
    expect(transcriptMtime(sid, root)).toBeNull()
    expect(base).toBeTruthy()
  })
  it('refuses a transcript reached through a symlinked project dir to outside the root', () => {
    const { base, root } = setup()
    const outside = join(base, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, `${sid}.jsonl`), '{}\n')
    symlinkSync(outside, join(root, 'link'))
    // only the symlinked dir holds the file
    expect(transcriptMtime(sid, root)).toBeNull()
  })
  it('refuses an unsafe session id and a missing root', () => {
    const { root } = setup()
    expect(transcriptMtime('../../etc/passwd', root)).toBeNull()
    expect(transcriptMtime(sid, join(root, 'nope'))).toBeNull()
  })
})

describe('repromptContinue: only a live idle agent', () => {
  function run(rec: Partial<AgentRecord>, live: boolean) {
    const f = openFixture(); seedPortfolio(f.db)
    const sent: string[] = []
    const host = {
      runnerFor: () => 'pty', spawnTier: () => 'R2', worktree: async () => '/wt', initialPrompt: async () => 'x', openPty: async () => undefined, headlessArgv: () => null,
      send: async (_n: string, t: string) => { sent.push(t); return { ok: true as const, started: true as const } }, scrollback: async () => [], closePty: async () => undefined, hasSession: () => live,
    } as unknown as AgentHost
    const guard = { check: () => ({ verdict: 'allow', level: 'act_gated' }), effectiveLevel: () => 'act_gated', recordUsage: () => undefined, breaker: { allow: () => ({ allowed: true, state: 'closed' }), trip: () => 'closed', recordSuccess: () => undefined } }
    const executor = createAgentExecutor({ db: f.db, guard: guard as never, host, now: () => NOW })
    executor.store.create({ id: 'a1', projectId: 'p1', kind: 'claude', role: 'worker', runner: 'pty', owner: 'central:c1', reqId: 'r-resume' } as never)
    for (const to of ['provisioning', 'starting', 'working', 'waiting_input'] as const) executor.store.transition('a1', to, to === 'working' ? { nodeId: 'c-a1' } : {})
    const record = { ...(executor.store.get('a1') as AgentRecord), ...rec }
    return { sent, call: () => repromptContinue({ store: { get: () => record }, executor }, 'a1') }
  }
  it('sends the continue prompt (with the git-status check) to a live waiting agent', async () => {
    const r = run({}, true)
    expect((await r.call()).ok).toBe(true)
    expect(r.sent[0]).toContain(CONTINUE_PROMPT)
    expect(CONTINUE_PROMPT).toContain('git status')
  })
  it.each([
    ['a dead session', {}, false, 'session_gone'],
    ['a working agent', { state: 'working' }, true, 'agent_busy'],
    ['a verifying agent', { state: 'verifying' }, true, 'agent_not_active'],
  ] as const)('refuses %s and sends nothing', async (_n, rec, live, code) => {
    const r = run(rec as Partial<AgentRecord>, live)
    expect((await r.call()).code).toBe(code)
    expect(r.sent).toEqual([])
  })
  it('an unknown agent is refused', async () => {
    const res = await repromptContinue({ store: { get: () => null }, executor: { prompt: vi.fn() } }, 'zz')
    expect(res).toMatchObject({ ok: false, code: 'agent_not_found' })
  })
})
