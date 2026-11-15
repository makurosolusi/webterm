import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openFixture, seedPortfolio, type Fixture } from '../centralTestFixture.testutil'
import { registerWorkspaceLookup, type WorkspaceRecord } from '../workspaceLookup'
import { createWorkStore } from '../work/workStore'
import { createHealthStore } from '../health/healthStore'
import { HEADER_MAX_CHARS, buildStateHeader, registerActiveWorkspace, registerApprovalSettings } from './contextHeader'

let f: Fixture
let workspaces: WorkspaceRecord[]
let active: string | null
const undo: Array<() => void> = []

beforeEach(() => {
  f = openFixture()
  seedPortfolio(f.db) // ledger: p1 (w-p1), p2 (w-p2), p3 (w-p3)
  workspaces = [ // test-only
    { id: 'w-p1', name: 'laya-api', nodes: [] },
    { id: 'ws-wibu', name: 'wibu', nodes: [] },
  ]
  active = null
  undo.push(registerWorkspaceLookup((id) => workspaces.find((w) => w.id === id) ?? null, () => workspaces))
  undo.push(registerActiveWorkspace(() => active))
})
afterEach(() => { while (undo.length) undo.pop()!(); f.close() })

type Header = { projects: unknown[]; viewing: { projectId: string; name: string } | null }
const parse = (text: string): Header => JSON.parse(text.slice('State: '.length)) as Header

describe('state header: viewing', () => {
  it('names the project of the workspace the user is viewing, as the last key', () => {
    active = 'ws-wibu' // a workspace whose project livePortfolio creates with id = workspace id
    const text = buildStateHeader(f.db, 'central:global')
    expect(parse(text).viewing).toEqual({ projectId: 'ws-wibu', name: 'wibu' })
    expect(Object.keys(JSON.parse(text.slice('State: '.length)) as object)).toEqual(['time', 'needsYou', 'openDuties', 'health', 'work', 'projectTotal', 'projects', 'scope', 'viewing'])
    active = 'w-p1' // an older project linked to its workspace under a different id
    expect(parse(buildStateHeader(f.db, 'central:global')).viewing).toEqual({ projectId: 'p1', name: 'laya-api' })
  })

  it('is null when nothing is active, or the active workspace was deleted', () => {
    expect(parse(buildStateHeader(f.db, 'central:global')).viewing).toBeNull()
    active = 'ws-gone'
    expect(parse(buildStateHeader(f.db, 'central:global')).viewing).toBeNull()
    active = 'w-p1'
    workspaces = workspaces.filter((w) => w.id !== 'w-p1')
    expect(parse(buildStateHeader(f.db, 'central:global')).viewing).toBeNull()
  })

  it('survives the shrink to the cap: projects are dropped, viewing never (name cut to 40)', () => {
    workspaces = Array.from({ length: 60 }, (_, i) => ({ id: `ws-${i}`, name: `${'n'.repeat(55)}${i}`, nodes: [] }))
    active = 'ws-7'
    const text = buildStateHeader(f.db, 'central:global')
    const header = parse(text)
    expect(text.length).toBeLessThanOrEqual(HEADER_MAX_CHARS)
    expect(header.projects.length).toBeLessThan(50)
    expect(header.viewing).toEqual({ projectId: 'ws-7', name: 'n'.repeat(40) })
  })

  // Policy lock (root cause: Central could not tell which workspace the user had open): the key is always there.
  it('always carries "viewing", whatever the state', () => {
    for (const [a, list] of [[null, workspaces], ['ws-wibu', workspaces], ['x', []], ['ws-wibu', Array.from({ length: 60 }, (_, i) => ({ id: `ws-${i}`, name: 'y'.repeat(40) }))]] as const) {
      active = a; workspaces = [...list]
      expect(buildStateHeader(f.db, 'central:project:p1')).toContain('"viewing":')
    }
  })
})

// Policy lock (root cause: Central was never told the approval level, so it proposed actions even in Danger).
describe('state header: approval mode per project', () => {
  const modes = (): Record<string, unknown> => Object.fromEntries((parse(buildStateHeader(f.db, 'central:global')).projects as Array<{ id: string; approval?: string }>).map((p) => [p.id, p.approval]))

  it('shows each project override, the global level as fallback, and follows a global change', () => {
    // Live workspaces: w-p1 (project p1) and ws-wibu (its own project). test-only settings below.
    let settings = { skipApprovals: false, claudePermissionMode: 'auto' as const, projectApprovalLevels: { 'ws-wibu': 'never' as const } as Record<string, 'always' | 'risky' | 'never'> }
    undo.push(registerApprovalSettings(() => settings))
    expect(modes()).toEqual({ p1: 'auto', 'ws-wibu': 'danger' })
    settings = { ...settings, skipApprovals: true, projectApprovalLevels: { 'w-p1': 'always' } }
    expect(modes()).toEqual({ p1: 'ask', 'ws-wibu': 'danger' })
  })

  it('omits the mode when no settings source is registered', () => {
    expect(Object.values(modes()).every((m) => m === undefined)).toBe(true)
  })
})

describe('state header: time and open work', () => {
  type Work = { id: string; columns: Record<string, number>; needsYou: Record<string, number>; liveAgents: number; open: Array<{ task: string; node: string; status: string; quietMin: number }> }
  type Rich = Header & { time: string; needsYou: Record<string, number>; work: Work[] }
  const rich = (text: string): Rich => JSON.parse(text.slice('State: '.length)) as Rich
  const NOW = 1_700_000_000_000
  const MIN = 60_000
  let tasks = 0
  const task = (projectId: string, status: string, node: string | null = null, title = `task ${tasks + 1}`): string => {
    const id = `tk${tasks += 1}`
    const store = createWorkStore(f.db, () => NOW - 5 * MIN)
    store.createTask({ id, projectId, title, objective: 'o', actor: { kind: 'central' } })
    if (node !== null) store.openAssignment({ taskId: id, nodeId: node, channel: 'terminal', instruction: 'go', actor: { kind: 'central' } })
    f.db.query('UPDATE central_task SET status = ? WHERE id = ?').run(status, id)
    return id
  }

  it('shows the local time with weekday and timezone', () => {
    expect(rich(buildStateHeader(f.db, 'central:global', NOW, 'Asia/Jakarta')).time).toBe('Wednesday, 15 November 2023 at 05:13 GMT+7 (Asia/Jakarta)')
  })

  it('reports board columns, needsYou, live agents and open assignments per project', () => {
    workspaces[0] = { id: 'w-p1', name: 'laya-api', nodes: [{ id: 'n1', name: 'builder' }] }
    task('p1', 'running', 'n1', 'build the api')
    task('p1', 'waiting_input')
    task('p1', 'failed')
    task('p1', 'done')
    task('p2', 'done')
    f.db.query(`INSERT INTO central_agents (id, project_id, kind, runner, state, owner, started_at) VALUES ('a1', 'p1', 'claude', 'pty', 'running', 'human', 1)`).run()
    const header = rich(buildStateHeader(f.db, 'central:global', NOW))
    expect(header.needsYou).toEqual({ waiting_input: 1, needs_review: 0, stalled: 0, failed: 1 })
    expect(header.work.map((w) => w.id)).toEqual(['p1'])
    expect(header.work[0]).toMatchObject({
      columns: { todo: 0, in_progress: 2, needs_review: 1, done: 1 }, needsYou: { waiting_input: 1, failed: 1 }, liveAgents: 1,
      open: [{ task: 'build the api', status: 'running', quietMin: 5 }],
    })
    expect(header.work[0]?.open[0]?.node).not.toBe('n1') // the display name, not the id
  })

  const setGoal = (id: string, statement: string, status: string): void => { f.db.query('UPDATE project SET goal_json = ? WHERE id = ?').run(JSON.stringify({ version: 1, status, statement }), id) }

  it('shows the goal statement and status, clipped, with the project work', () => {
    task('p1', 'running', 'n1')
    setGoal('p1', 'g'.repeat(300), 'active')
    const [work] = rich(buildStateHeader(f.db, 'central:global', NOW)).work as Array<Work & { goal: { statement: string; status: string } }>
    expect(work?.goal).toEqual({ statement: 'g'.repeat(120), status: 'active' })
  })

  it('lists a project with a live goal and an empty board, and not one whose goal is closed', () => {
    setGoal('p2', 'Plan me', 'proposed')
    setGoal('p3', 'Long gone', 'abandoned')
    const { work } = rich(buildStateHeader(f.db, 'central:global', NOW))
    expect(work.map((w) => w.id)).toEqual(['p2'])
    expect(work[0]).toMatchObject({ goal: { statement: 'Plan me', status: 'proposed' }, columns: { todo: 0 } })
  })

  it('goals stay inside the cap and go with their project in the shrink', () => {
    workspaces = Array.from({ length: 60 }, (_, i) => ({ id: `ws-${i}`, name: `${'n'.repeat(55)}${i}`, nodes: [] }))
    buildStateHeader(f.db, 'central:global', NOW)
    for (let i = 0; i < 40; i += 1) { task(`ws-${i}`, 'stalled', `node-${i}`, 't'.repeat(70)); setGoal(`ws-${i}`, 'g'.repeat(400), 'active') }
    const text = buildStateHeader(f.db, 'central:global', NOW)
    expect(text.length).toBeLessThanOrEqual(HEADER_MAX_CHARS)
    expect(rich(text).needsYou.stalled).toBe(40)
  })

  it('lists at most 8 open assignments per project', () => {
    for (let i = 0; i < 12; i += 1) task('p1', 'running', `node-${i}`)
    expect(rich(buildStateHeader(f.db, 'central:global', NOW)).work[0]?.open).toHaveLength(8)
  })

  // 40 projects x 3 assignments is already far past the cap (the shrink drops all detail); each task() is a real ledger write (~0.6 ms), so
  // the old 8 per project cost ~200 ms alone and blew the 5 s default when the full suite ran in parallel.
  it('shrinks detail first and is deterministic: time, needsYou and viewing survive any load', () => {
    workspaces = Array.from({ length: 60 }, (_, i) => ({ id: `ws-${i}`, name: `${'n'.repeat(55)}${i}`, nodes: [] }))
    active = 'ws-7'
    buildStateHeader(f.db, 'central:global', NOW)
    for (let i = 0; i < 40; i += 1) for (let j = 0; j < 3; j += 1) task(`ws-${i}`, j === 0 ? 'stalled' : 'running', `node-${i}-${j}`, `${'t'.repeat(70)}${j}`)
    const text = buildStateHeader(f.db, 'central:global', NOW)
    const header = rich(text)
    expect(text.length).toBeLessThanOrEqual(HEADER_MAX_CHARS)
    expect(header.time).toContain('2023')
    expect(header.needsYou.stalled).toBe(40)
    expect(header.viewing?.projectId).toBe('ws-7')
    expect(header.work.every((w) => w.open.length === 0)).toBe(true)
    expect(buildStateHeader(f.db, 'central:global', NOW)).toBe(text)
  })

  it('lists open duties of Central-started attempts, never cancelled or done, and keeps them through the shrink', () => {
    type Duty = { taskId: string; task: string; node: string; status: string; reason: string | null; attempts: number; sinceMin: number }
    const duties = (text: string): Duty[] => (JSON.parse(text.slice('State: '.length)) as { openDuties: Duty[] }).openDuties
    const stuck = task('p1', 'failed', 'n-stuck', 'deploy the api')
    task('p1', 'cancelled', 'n-gone'); task('p1', 'done', 'n-done'); task('p1', 'running', 'n-busy')
    expect(duties(buildStateHeader(f.db, 'central:global', NOW))).toEqual([{ taskId: stuck, task: 'deploy the api', node: 'n-stuck', status: 'failed', reason: null, attempts: 1, sinceMin: 5 }])
    workspaces = Array.from({ length: 60 }, (_, i) => ({ id: `ws-${i}`, name: `${'n'.repeat(55)}${i}`, nodes: [] }))
    buildStateHeader(f.db, 'central:global', NOW)
    for (let i = 0; i < 40; i += 1) for (let j = 0; j < 8; j += 1) task(`ws-${i}`, j === 0 ? 'stalled' : 'running', `node-${i}-${j}`, `${'t'.repeat(70)}${j}`)
    const text = buildStateHeader(f.db, 'central:global', NOW)
    expect(text.length).toBeLessThanOrEqual(HEADER_MAX_CHARS)
    expect(duties(text)).toHaveLength(5)
    expect(duties(text).every((d) => d.task.length <= 60)).toBe(true)
  })

  it('moderate load keeps every project and trims its assignments evenly', () => {
    for (const p of ['p1', 'p2', 'p3']) for (let j = 0; j < 8; j += 1) task(p, 'running', `${p}-node-${j}`, `${'t'.repeat(58)}${j}`)
    const header = rich(buildStateHeader(f.db, 'central:global', NOW))
    expect(header.work).toHaveLength(3)
    expect(new Set(header.work.map((w) => w.open.length)).size).toBe(1)
    expect(buildStateHeader(f.db, 'central:global', NOW).length).toBeLessThanOrEqual(HEADER_MAX_CHARS)
  })
})

describe('state header: health line', () => {
  const NOW = 1_700_000_000_000 // test-only fixed clock
  const HOUR = 60 * 60_000
  const health = (conv: string): unknown => (JSON.parse(buildStateHeader(f.db, conv, NOW).slice('State: '.length)) as { health: unknown }).health
  const scan = (projectId: string, severities: Array<'high' | 'medium' | 'low'>, at: number): void => {
    const store = createHealthStore(f.db, () => at)
    const s = store.startScan(projectId, 'scan')
    store.finishScan(s.id, {
      drafts: severities.map((severity, i) => ({ rule: 'file_size', severity, confidence: 'high', file: `f${i}.ts`, line: 1, title: 't', evidence: 'e', source: 'Rule 8', suggestion: 's', fingerprint: `${projectId}-${i}` })),
      rules: ['file_size'], filesScanned: severities.length, truncated: false,
    })
  }

  it('a project chat shows its counts and last scan age, or that it was never scanned', () => {
    expect(health('central:project:p1')).toBe('never scanned')
    scan('p1', ['high', 'low', 'low'], NOW - 2 * HOUR)
    expect(health('central:project:p1')).toBe('3 open (1 high, 2 low) · last scan 2h ago')
    scan('p1', [], NOW - 5 * 60_000)
    expect(health('central:project:p1')).toBe('0 open · last scan 5m ago')
  })

  it('the global chat names only projects with open high findings', () => {
    expect(health('central:global')).toBe('no open high findings')
    scan('p1', ['high', 'high', 'low'], NOW - 3 * 24 * HOUR)
    scan('p2', ['medium'], NOW)
    scan('p3', ['high'], NOW)
    expect(health('central:global')).toBe('3 open high in 2 project(s): laya-api 2, Gamma 1')
  })

  it('stays under the cap when the header shrinks', () => {
    scan('p1', ['high'], NOW)
    workspaces = Array.from({ length: 60 }, (_, i) => ({ id: `ws-${i}`, name: `${'n'.repeat(55)}${i}`, nodes: [] }))
    const text = buildStateHeader(f.db, 'central:project:p1', NOW)
    expect(text.length).toBeLessThanOrEqual(HEADER_MAX_CHARS)
    expect(text).toContain('"health":"1 open (1 high) · last scan 0m ago"')
  })
})
