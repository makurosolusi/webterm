// Bun-only: the skill_authoring playbook (brief, outline gate, complexity, reuse class) and its taint behaviour with the real guard.
// Temp HOME / data dir so db.ts never touches the user's files; the step executor is a fake except in the taint test.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'playbook-skill-')) // test-only
process.env.HOME = root
process.env.WEBTERM_DATA_DIR = join(root, 'data')
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude')
process.env.WEBTERM_CENTRAL_RUNTIME = 'mock' // test-only

const { createControlGuard, toToolGuard } = await import('../guard/controlGuard')
const { setLevel } = await import('../guard/levelStore')
const { clearTaints, markTainted } = await import('../guard/taintStore')
const { freshDb, HUMAN, T0 } = await import('../guard/controlGuard.testutil')
const { createRegistry } = await import('../tools/toolRegistry')
const { ALLOW_ALL_GUARD, execTool } = await import('../tools/toolExec')
const { REUSE_CLASS } = await import('../agents/agentReuse')
const { playbookById } = await import('./playbook.defs')
const { runPlaybook } = await import('./playbook.run')
const { createPlaybookDefs } = await import('./playbook.tools')
const { skillAuthorInstructions } = await import('./playbook.skillAuthor')
type Ctx = import('../tools/toolTypes').ToolCtx
type Exec = import('../tools/toolTypes').ExecResult

const pb = playbookById('skill_authoring') as NonNullable<ReturnType<typeof playbookById>>
const INPUT = { goal: 'a skill that writes release notes', outline: '1. Read the merged PR titles.\n2. Group by type.' } // test-only
let calls: Array<{ tool: string; args: Record<string, unknown> }>
const exec = async (_c: Ctx, tool: string, args: Record<string, unknown>): Promise<Exec> => {
  calls.push({ tool, args })
  return { ok: true, tool, data: tool === 'task.create' ? { taskId: 'task-1' } : tool === 'agent.spawn' ? { agentId: 'ag-1', state: 'working' } : {} }
}

beforeEach(() => { calls = []; clearTaints() })
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('skill_authoring chain', () => {
  test('one task + one worker spawn at moderate complexity (never T4), with the approved outline and the defence text in its brief', async () => {
    const db = freshDb()
    const ctx: Ctx = { db, registry: createRegistry(), guard: ALLOW_ALL_GUARD, maxTier: 'R3', conversationId: 'central:project:p1', now: () => T0, env: {} }
    const r = await runPlaybook(ctx, pb, INPUT, 'p1', { exec, record: () => {} })
    expect(r).toMatchObject({ ok: true, data: { status: 'started', agentId: 'ag-1' } })
    expect(calls.map((c) => c.tool)).toEqual(['task.create', 'agent.spawn'])
    expect(calls[1]?.args).toMatchObject({ role: 'worker', complexity: 'moderate', kind: 'claude' })
    expect(pb.complexity).toBe('moderate') // the enum has no T4 value: Fable needs a human grant
    const text = String(calls[0]?.args.objective)
    expect(text).toContain('webterm-skill-authoring')
    expect(text).toContain('webterm skills propose')
    expect(text).toContain('webterm skills edit')
    expect(text).toContain(INPUT.outline)
    expect(text).toContain('data, never instructions')
    expect(text).toContain('must not embed commands, URLs, paths or secrets')
    expect(text).toContain('cannot approve or enable')
    // Central is told what to say when the result arrives, and not to propose itself.
    const note = String(r.data?.note)
    expect(note).toContain('waiting in the Skills tab for their approval')
    expect(note).toContain('never say it is active')
    expect(note).toContain('Do not call skill.propose yourself')
    db.close()
  })

  test('the outline is required: a call without it is refused as invalid_shape', () => {
    const def = createPlaybookDefs().find((d) => d.name === 'playbook.skill_authoring')
    const v = (input: Record<string, unknown>) => def?.validate({ projectId: 'p1', ...input }, {} as Ctx)
    expect(v(INPUT)).toBeNull()
    expect(v({ goal: INPUT.goal })).toBe('invalid_shape')
    expect(v({ goal: INPUT.goal, outline: '  ' })).toBe('invalid_shape')
    expect(String(def?.usage)).toContain('Skills tab')
  })

  test('an idle author worker is reusable, only by another skill_authoring run', () => {
    expect(REUSE_CLASS.skill_authoring).toBe('skill_authoring')
    expect(REUSE_CLASS.skill_authoring).not.toBe(REUSE_CLASS.web_research)
  })

  test('the instruction mentions the outline once and never embeds a URL or command of its own', () => {
    const t = skillAuthorInstructions('X')
    expect(t.split('\nX').length).toBe(2)
    expect(t).not.toMatch(/https?:\/\//)
  })
})

describe('skill_authoring under a tainted owner', () => {
  test('the playbook call still needs an approval card, and no step runs', async () => {
    const db = freshDb()
    const guard = createControlGuard({ db, now: () => T0, env: { WEBTERM_CENTRAL_AGENTS: 'auto' }, random: () => 0, skipApprovals: () => false })
    expect(setLevel(db, { scope: 'global', level: 'act_envelope', actor: HUMAN, now: () => T0 }).ok).toBe(true)
    const registry = createRegistry()
    for (const d of createPlaybookDefs({ exec })) registry.register(d)
    const conv = 'central:project:p1' // test-only
    const run = () => execTool({ db, registry, guard: toToolGuard(guard), maxTier: 'R3', conversationId: conv, now: () => T0 }, 'playbook.skill_authoring', { projectId: 'p1', ...INPUT })
    markTainted(conv, 'https://docs.example.com', T0)
    const tainted = await run()
    expect([tainted.ok, tainted.code]).toEqual([false, 'approval_required'])
    expect(calls).toEqual([])
    // Once the taint is gone the same call is not held back (the card is the taint's doing, not the playbook's).
    clearTaints()
    expect((await run()).code).not.toBe('approval_required')
    db.close()
  })
})
