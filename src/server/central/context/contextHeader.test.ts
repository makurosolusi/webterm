import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openFixture, seedPortfolio, type Fixture } from '../centralTestFixture.testutil'
import { registerWorkspaceLookup, type WorkspaceRecord } from '../workspaceLookup'
import { HEADER_MAX_CHARS, buildStateHeader, registerActiveWorkspace } from './contextHeader'

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
    expect(Object.keys(JSON.parse(text.slice('State: '.length)) as object)).toEqual(['projectTotal', 'projects', 'scope', 'viewing'])
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
