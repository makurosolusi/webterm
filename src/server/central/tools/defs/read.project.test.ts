import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { allRows } from '../../../ledger/ledgerCore'
import { openFixture, seedPortfolio, type Fixture } from '../../centralTestFixture.testutil'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import { createRegistry } from '../toolRegistry'
import type { ToolCtx } from '../toolTypes'
import { PROJECT_READ_DEFS } from './read.project'
import { READ_TOOLS_FLAG } from './read.shared'

let f: Fixture
let dir: string
beforeEach(() => {
  f = openFixture()
  seedPortfolio(f.db)
  dir = mkdtempSync(join(tmpdir(), 'ca2-read-'))
  f.db.query('UPDATE project SET path = ? WHERE id = ?').run(dir, 'p1')
})
afterEach(() => { f.close(); rmSync(dir, { recursive: true, force: true }) })

function ctx(env: Record<string, string> = { [READ_TOOLS_FLAG]: 'on' }, conversationId = 'central:global'): ToolCtx {
  const registry = createRegistry()
  PROJECT_READ_DEFS.forEach((d) => registry.register(d))
  return { db: f.db, registry, guard: ALLOW_ALL_GUARD, maxTier: 'R0', conversationId, now: () => 1, env }
}

describe('project.read', () => {
  it('returns branch, sorted entries and truncated docs; skips .git, node_modules, env and secret files', async () => {
    mkdirSync(join(dir, '.git')); mkdirSync(join(dir, 'node_modules')); mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/feature/x\n')
    writeFileSync(join(dir, '.env'), 'TOKEN=abcdefghij'); writeFileSync(join(dir, 'server.pem'), 'x')
    writeFileSync(join(dir, 'README.md'), 'r'.repeat(5000)); writeFileSync(join(dir, 'b.txt'), 'b')
    const res = await execTool(ctx(), 'project.read', { projectId: 'p1' })
    expect(res.ok).toBe(true)
    const data = res.data as { branch: string; entries: string[]; readme: string; claudeMd: string | null; entriesTotal: number }
    expect(data.branch).toBe('feature/x')
    expect(data.entries).toEqual(['README.md', 'b.txt', 'src/'])
    expect(data.entriesTotal).toBe(3)
    expect(data.readme.length).toBe(2048)
    expect(data.claudeMd).toBeNull()
  })

  it('reads the branch through a worktree .git file, short sha when detached, null when not a repo', async () => {
    mkdirSync(join(dir, 'gd'))
    writeFileSync(join(dir, 'gd', 'HEAD'), '0123456789abcdef\n')
    writeFileSync(join(dir, '.git'), 'gitdir: gd\n')
    expect((await execTool(ctx(), 'project.read', { projectId: 'p1' })).data?.branch).toBe('01234567')
    rmSync(join(dir, '.git'))
    expect((await execTool(ctx(), 'project.read', { projectId: 'p1' })).data?.branch).toBeNull()
  })

  it('does not follow a symlinked README out of the project', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'ca2-out-'))
    writeFileSync(join(outside, 'secret.txt'), 'outside-secret')
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'README.md'))
    const res = await execTool(ctx(), 'project.read', { projectId: 'p1' })
    rmSync(outside, { recursive: true, force: true })
    expect(res.data?.readme).toBeNull()
    expect(JSON.stringify(res)).not.toContain('outside-secret')
  })

  it('caps entries at 60 but reports the total', async () => {
    for (let i = 0; i < 75; i++) writeFileSync(join(dir, `f${String(i).padStart(3, '0')}`), '')
    const data = (await execTool(ctx(), 'project.read', { projectId: 'p1' })).data as { entries: string[]; entriesTotal: number }
    expect([data.entries.length, data.entriesTotal]).toEqual([60, 75])
  })

  it('fails with coded results: unreadable path, unknown project, forbidden key, missing project, flag off', async () => {
    f.db.query('UPDATE project SET path = ? WHERE id = ?').run(join(dir, 'missing'), 'p1')
    expect(await execTool(ctx(), 'project.read', { projectId: 'p1' })).toMatchObject({ ok: false, code: 'path_unreadable' })
    expect(await execTool(ctx(), 'project.read', { projectId: 'nope' })).toMatchObject({ ok: false, code: 'project_not_found' })
    expect(await execTool(ctx(), 'project.read', {})).toMatchObject({ ok: false, code: 'project_required' })
    expect(await execTool(ctx(), 'project.read', { projectId: 'p1', path: '/etc' })).toMatchObject({ ok: false, code: 'forbidden_key' })
    expect(await execTool(ctx({}), 'project.read', { projectId: 'p1' })).toMatchObject({ ok: false, code: 'flag_off' })
    expect(await execTool(ctx(undefined, 'central:project:p2'), 'project.read', { projectId: 'p1' })).toMatchObject({ code: 'conversation_project_mismatch' })
  })

  it('audits every call without the project path', async () => {
    await execTool(ctx(), 'project.read', { projectId: 'p1' })
    const rows = allRows(f.db, "SELECT payload_json FROM event WHERE kind = 'central.proposal'").map((r) => String(r['payload_json']))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('project.read')
    expect(rows[0]).not.toContain(dir)
  })
})
