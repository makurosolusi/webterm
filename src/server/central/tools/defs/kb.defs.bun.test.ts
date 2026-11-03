// Bun-only: knowledge tools through the real execTool gate (flag, validation, tier, audit).
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { allRows } from '../../../ledger/ledgerCore'
import { FIXTURE_SECRET, NOW, makeLedger, makeRepo, sh } from '../../../knowledge/knowledgeFixture.testutil'
import { openKnowledgeDb } from '../../../knowledge/knowledgeStore'
import { refreshIndex } from '../../../knowledge/knowledgeFresh'
import { registerWorkspaceLookup } from '../../workspaceLookup'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import { createRegistry } from '../toolRegistry'
import type { ToolCtx } from '../toolTypes'
import { KNOWLEDGE_FLAG, createKnowledgeDefs } from './kb.defs'

function setup(root: string, env: Record<string, string | undefined>) {
  const kb = openKnowledgeDb(':memory:')
  const ledger = makeLedger(root)
  const registry = createRegistry()
  for (const def of createKnowledgeDefs(() => kb)) registry.register(def)
  const ctx: ToolCtx = { db: ledger, registry, guard: ALLOW_ALL_GUARD, maxTier: 'R0', conversationId: 'global', now: () => NOW, env }
  return { kb, ledger, ctx }
}

test('all four tools are R0 and off without the flag', async () => {
  const root = makeRepo()
  const { ctx } = setup(root, {})
  expect(ctx.registry.list().map((d) => d.name).sort().join(',')).toBe('kb.map,kb.search,project.brief,project.discover')
  expect(ctx.registry.list().every((d) => d.tier === 'R0' && d.flag === KNOWLEDGE_FLAG)).toBe(true)
  const r = await execTool(ctx, 'kb.search', { projectId: 'p1', query: 'zebraquokka' })
  expect(r.ok).toBe(false)
  expect(r.code).toBe('flag_off')
  rmSync(root, { recursive: true, force: true })
})

test('kb.search, kb.map and project.brief answer with asOf and stale when on', async () => {
  const root = makeRepo()
  const { ctx } = setup(root, { [KNOWLEDGE_FLAG]: 'on' })
  const s = await execTool(ctx, 'kb.search', { projectId: 'p1', query: 'zebraquokka', limit: 3 })
  expect(s.ok).toBe(true)
  const sd = s.data as { stale: boolean; asOf: { sha: string }; hits: Array<{ path: string }> }
  expect(sd.stale).toBe(false)
  expect(sd.asOf.sha.length).toBe(40)
  expect(sd.hits[0]?.path).toBe('README.md')
  const m = await execTool(ctx, 'kb.map', { projectId: 'p1', limit: 1 })
  expect((m.data as { modules: unknown[] }).modules.length).toBe(1)
  const b = await execTool(ctx, 'project.brief', { projectId: 'p1' })
  expect(b.ok).toBe(true)
  expect((b.data as { projectId: string }).projectId).toBe('p1')
  expect(JSON.stringify(b.data).includes(FIXTURE_SECRET)).toBe(false)
  // every call is audited, with no query text in the audit payload
  const audits = allRows(ctx.db, "SELECT payload_json FROM event WHERE kind = 'central.proposal'").map((r) => String(r.payload_json))
  expect(audits.length).toBe(3)
  expect(audits.some((a) => a.includes('zebraquokka'))).toBe(false)
  rmSync(root, { recursive: true, force: true })
})

test('stale is reported after a new commit; the next call refreshes', async () => {
  const root = makeRepo()
  const { ctx, kb } = setup(root, { [KNOWLEDGE_FLAG]: 'on' })
  await refreshIndex(kb, 'p1', root, NOW - 1000)
  writeFileSync(join(root, 'src/z.ts'), 'export const zeta = 1\n')
  sh(root, 'add', '.')
  sh(root, 'commit', '-q', '-m', 'z')
  const brief = await execTool(ctx, 'project.brief', { projectId: 'p1' })
  expect((brief.data as { stale: string[] }).stale).toContain('index')
  const hit = await execTool(ctx, 'kb.search', { projectId: 'p1', query: 'zeta' })
  expect((hit.data as { stale: boolean; hits: Array<{ path: string }> }).stale).toBe(false)
  expect((hit.data as { hits: Array<{ path: string }> }).hits[0]?.path).toBe('src/z.ts')
  rmSync(root, { recursive: true, force: true })
})

test('input validation: bad query/limit/unknown project are coded failures', async () => {
  const root = makeRepo()
  const { ctx } = setup(root, { [KNOWLEDGE_FLAG]: 'on' })
  expect((await execTool(ctx, 'kb.search', { projectId: 'p1', query: '' })).code).toBe('invalid_shape')
  expect((await execTool(ctx, 'kb.search', { projectId: 'p1', query: 'x'.repeat(201) })).code).toBe('invalid_shape')
  expect((await execTool(ctx, 'kb.map', { projectId: 'p1', limit: 0 })).code).toBe('invalid_shape')
  expect((await execTool(ctx, 'kb.map', { projectId: 'nope' })).code).toBe('project_not_found')
  rmSync(root, { recursive: true, force: true })
})

test('files outside the project root are never read (symlinked README)', async () => {
  const root = makeRepo()
  const outside = mkdtempSync(join(tmpdir(), 'kbout-'))
  writeFileSync(join(outside, 'secret.md'), `# Out\n\noutsidemarker ${FIXTURE_SECRET}\n`)
  mkdirSync(join(root, 'docs/decisions'), { recursive: true })
  symlinkSync(join(outside, 'secret.md'), join(root, 'docs/decisions/escape.md'))
  symlinkSync(outside, join(root, 'linkdir'))
  const { ctx } = setup(root, { [KNOWLEDGE_FLAG]: 'on' })
  const r = await execTool(ctx, 'kb.search', { projectId: 'p1', query: 'outsidemarker' })
  expect(r.ok).toBe(true)
  expect((r.data as { hits: unknown[] }).hits.length).toBe(0)
  const all = await execTool(ctx, 'kb.map', { projectId: 'p1', limit: 100 })
  expect(JSON.stringify(all.data).includes('linkdir')).toBe(false)
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

test('project.discover lists workspaces without a project, with git root', async () => {
  const root = makeRepo()
  const plain = mkdtempSync(join(tmpdir(), 'kbplain-'))
  const { ctx, ledger } = setup(root, { [KNOWLEDGE_FLAG]: 'on' })
  expect(JSON.stringify((await execTool(ctx, 'project.discover', {})).data)).toBe('{"workspaces":[]}') // no store registered yet
  // The workspace store is webterm.db, a separate file: the ledger has no workspace table (production layout).
  const store = [
    { id: 'w-git', name: 'a repo', cwd: join(root, 'src'), updatedAt: 3 },
    { id: 'w-plain', name: 'plain dir', cwd: plain, updatedAt: 2 },
    { id: 'w-p1', name: 'registered', cwd: root, updatedAt: 1 },
  ]
  const unregister = registerWorkspaceLookup((id) => store.find((w) => w.id === id) ?? null, () => store)
  const r = await execTool(ctx, 'project.discover', {})
  unregister()
  const ws = (r.data as { workspaces: Array<{ workspaceId: string; gitRoot: string | null }> }).workspaces
  expect(ws.map((w) => w.workspaceId).join(',')).toBe('w-git,w-plain')
  expect(ws[0]?.gitRoot?.endsWith(root.split('/').pop() as string)).toBe(true)
  expect(ws[1]?.gitRoot).toBe(null)
  expect((await execTool(ctx, 'project.discover', { limit: 99 })).code).toBe('invalid_shape')
  rmSync(root, { recursive: true, force: true })
  rmSync(plain, { recursive: true, force: true })
})
