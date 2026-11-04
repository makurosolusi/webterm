// Bun-only: real fixture repo (git), real ledger schema, real repo-map cache, the real route entry.
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Workspace } from '../../shared/workspace'
import { addProcedural } from '../awareness/proceduralMemory'
import { makeLedger, put, sh } from '../knowledge/knowledgeFixture.testutil'
import { openRepoMapDb } from '../knowledge/repoMapCache'
import { HOUSE_RULES } from '../webtermAwareness'
import { buildProvenance } from './provenance'
import { type CollectDeps, collectProvenance, nodeContext } from './provenance.collect'

process.env.WEBTERM_DATA_DIR = mkdtempSync(join(tmpdir(), 'wt-k2-')) // test-only: dataDir() and ../db stay out of the real home

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'prov-'))
  sh(dir, 'init', '-q')
  put(dir, {
    'src/hub.ts': 'export function sharedHubHelper() { return 1 }\n',
    'src/a.ts': "import { sharedHubHelper } from './hub'\nexport const alphaThing = sharedHubHelper()\n",
    '.cursor/rules/ui.mdc': '---\nglobs: "*.tsx"\n---\nUse function components.\n',
    'AGENTS.md': 'Run tests first.\n',
    'CLAUDE.md': '# Project\n',
  })
  sh(dir, 'add', '.')
  sh(dir, 'commit', '-q', '-m', 'init')
  return dir
}

const board = (cwd: string): Workspace => ({
  id: 'w1', name: 'Board', cwd, viewport: { x: 0, y: 0, zoom: 1 }, updatedAt: 0,
  nodes: [{ id: 'a1', kind: 'agent', x: 0, y: 0, title: 'Claude main', agentId: 'claude' }], bridges: [],
}) as unknown as Workspace

test('provenance lists every source with size, and counts only what is in context', async () => {
  const root = repo()
  const ledger = makeLedger(root)
  addProcedural(ledger, 'human-ui', 'Always run tests with TMPDIR=/tmp/st')
  const deps: CollectDeps = { workspaces: () => [board(root)], ledger: () => ledger, repoMapDb: () => openRepoMapDb(':memory:'), mcpTools: async () => ['repo_map', 'kb_search'] }
  const ctx = await nodeContext(deps, 'a1')
  expect(ctx?.touched).toEqual([])
  const p = await collectProvenance(deps, ctx as NonNullable<typeof ctx>)
  const by = Object.fromEntries(p.items.map((i) => [i.label, i]))
  expect(Object.keys(by)).toEqual(['webterm house rules', 'Awareness block', 'Identifier card', 'Standing preferences',
    '.cursor/rules/ui.mdc', 'AGENTS.md', 'CLAUDE.md', 'webterm MCP tools', 'webterm:explore', 'Repo map'])
  expect(by['webterm house rules']).toMatchObject({ when: 'system-prompt', chars: HOUSE_RULES.length, loaded: true })
  expect(by['Standing preferences']).toMatchObject({ loaded: true, detail: '1 verified' })
  expect(by['.cursor/rules/ui.mdc']).toMatchObject({ when: 'on-touch', loaded: false })
  expect(by['AGENTS.md']).toMatchObject({ when: 'session-start', loaded: true })
  expect(by['CLAUDE.md']).toMatchObject({ when: 'claude-code', loaded: true })
  expect(by['webterm MCP tools']).toMatchObject({ detail: '2 tools' })
  expect(by['Repo map']).toMatchObject({ when: 'on-demand', loaded: false })
  expect(by['Repo map']?.detail).toBe('2 of 2 files')
  const inContext = p.items.filter((i) => i.loaded && i.when !== 'on-demand')
  expect(p.loadedChars).toBe(inContext.reduce((s, i) => s + i.chars, 0))
  // Opening a matching file pulls the glob rule in.
  const opened = await collectProvenance(deps, await nodeContext(deps, 'a1', ['src/Panel.tsx']) as NonNullable<typeof ctx>)
  expect(opened.items.find((i) => i.label === '.cursor/rules/ui.mdc')?.loaded).toBe(true)
  expect(opened.loadedChars).toBeGreaterThan(p.loadedChars)
  expect(await nodeContext(deps, 'missing')).toBeNull()
  rmSync(root, { recursive: true, force: true })
})

test('buildProvenance: no ledger facts and no repo = nothing claimed', () => {
  const p = buildProvenance({
    houseRules: { text: 'x', source: 'f' }, awareness: '', card: '', procedural: { text: '', count: 0 },
    rules: [], touched: [], mcpTools: [], subagent: null, repoMap: null, handoff: { text: 'hand', source: 'checkpoint' },
  })
  expect(p.items.map((i) => `${i.kind}:${i.loaded}`)).toEqual(['house-rules:true', 'awareness:true', 'card:true', 'procedural:false', 'mcp-tools:false', 'handoff:true'])
  expect(p.loadedChars).toBe(5)
})

test('route: GET only, nodeId required, unknown node is 404', async () => {
  const { knowledge2Routes } = await import('../routes/knowledge2.routes')
  const call = async (method: string, url: string): Promise<{ status: number; body: unknown }> => {
    let status = 0
    let body = ''
    const res = { statusCode: 0, setHeader() {}, end(d?: string) { status = this.statusCode; body = d ?? '' } }
    const u = new URL(url, 'http://x')
    const ctx = { req: {}, res, url: u, path: u.pathname, method, ledger: () => null } as never
    const r = knowledge2Routes[0]
    expect(r?.match?.(ctx)).toBe(true)
    await r?.handle(ctx)
    return { status, body: body ? JSON.parse(body) : null }
  }
  expect(await call('POST', '/api/knowledge2/provenance?nodeId=a')).toEqual({ status: 405, body: { error: 'method_not_allowed' } })
  expect(await call('GET', '/api/knowledge2/provenance')).toEqual({ status: 400, body: { error: 'node_id_required' } })
  expect(await call('GET', '/api/knowledge2/rules?nodeId=nope')).toEqual({ status: 404, body: { error: 'node_not_found' } })
})
