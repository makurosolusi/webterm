// P4b file+git truth behind WEBTERM_MEMORY_FILES. Real fs temp dirs and real SQLite
// (node:sqlite, same DDL as the ledger); git is faked for argv assertions plus one
// real-git integration case.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { DDL_V1 } from '../ledger/ledgerSchemaV1'
import { type Memory, type MemoryAuthority, MemoryAuthorityError, MemoryConflictError } from './memoryModel'
import {
  MEMORY_FILES_FLAG, type MemoryFileExecResult, type MemoryFilePort, type MemorySqlDb, assertConfined,
  createMemoryFilePort, memoryCommitMessage, memoryFileRelPath, memoryFilesEnabled, memorySqlDb,
  parseMemoryFile, rebuildMemoryIndex, renderMemoryFile, resolveInside, safeSegment, writeMemoryFactFile,
} from './memoryFile'

const T0 = 1_700_000_000_000
const HUMAN: MemoryAuthority = { kind: 'human', id: 'human-1' }
const ORCH: MemoryAuthority = { kind: 'orchestrator', id: 'orch' }
const WORKER: MemoryAuthority = { kind: 'worker', id: 'worker-1' }

const tempDirs: string[] = []

async function tempDir(prefix = 'webterm-memfile-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  delete process.env[MEMORY_FILES_FLAG]
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function withFlag<T>(fn: () => Promise<T>): Promise<T> {
  process.env[MEMORY_FILES_FLAG] = 'on'
  try {
    return await fn()
  } finally {
    delete process.env[MEMORY_FILES_FLAG]
  }
}

interface IndexFixture { sql: MemorySqlDb; runCalls: string[] }

function indexFixture(): IndexFixture {
  const db = new DatabaseSync(':memory:')
  db.exec(DDL_V1)
  const runCalls: string[] = []
  const sql = memorySqlDb({
    all: (text, ...p) => (db.prepare(text) as unknown as { all(...a: unknown[]): Record<string, unknown>[] }).all(...p),
    run: (text, ...p) => {
      runCalls.push(text)
      return (db.prepare(text) as unknown as { run(...a: unknown[]): unknown }).run(...p)
    },
  })
  return { sql, runCalls }
}

function ensureProject(sql: MemorySqlDb, id: string): void {
  if (sql.all('SELECT id FROM project WHERE id = ?', id).length > 0) return
  sql.run('INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    id, `w-${id}`, id, `/tmp/${id}`, T0, T0)
}

interface FactOverrides {
  id?: string; projectId?: string; scope?: string; key?: string; title?: string
  body?: string; status?: string; updatedAt?: number
}

function insertMemory(sql: MemorySqlDb, over: FactOverrides = {}): string {
  const id = over.id ?? 'm1'
  ensureProject(sql, over.projectId ?? 'p1')
  sql.run(
    `INSERT INTO memory (id, project_id, scope, key, title, body, status, source_kind, source_ref,
       supersedes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,'file','src/x.ts',NULL,?,?)`,
    id, over.projectId ?? 'p1', over.scope ?? 'project', over.key ?? 'deploy-notes',
    over.title ?? 'Deploy notes', over.body ?? 'old body', over.status ?? 'fact',
    over.updatedAt ?? T0, over.updatedAt ?? T0
  )
  return id
}

function memoryOf(over: Partial<Memory> = {}): Memory {
  return {
    id: 'm1', projectId: 'p1', scope: 'project', key: 'deploy-notes', title: 'Deploy notes',
    body: 'old body', status: 'fact', sourceKind: 'file', sourceRef: 'src/x.ts',
    supersedes: null, supersededAt: null, createdAt: T0, updatedAt: T0, ...over,
  }
}

interface FakePort {
  port: MemoryFilePort
  calls: Array<{ file: string; args: string[]; cwd: string }>
  writes: Array<{ relPath: string; content: string }>
  readonly lists: number
  readonly ensures: number
}

function fakePort(root: string, options: { content?: string | null; files?: string[] } = {}): FakePort {
  const calls: FakePort['calls'] = []
  const writes: FakePort['writes'] = []
  let lists = 0
  let ensures = 0
  const port: MemoryFilePort = {
    root,
    ensure: async () => void (ensures += 1),
    read: async () => (options.content === undefined ? null : options.content),
    write: async (relPath, content) => void writes.push({ relPath, content }),
    list: async () => {
      lists += 1
      return options.files ?? []
    },
    exec: async (file, args, cwd) => {
      calls.push({ file, args, cwd })
      const message = args.includes('commit') ? args[args.indexOf('-m') + 1] ?? '' : ''
      return args.includes('commit') ? { code: 0, stdout: `[main abc1234] ${message}\n`, stderr: '' } : { code: 0, stdout: '', stderr: '' }
    },
  }
  return { port, calls, writes, get lists() { return lists }, get ensures() { return ensures } }
}

function memoryMd(frontmatter: Record<string, unknown>, body: string): string {
  const fm = { status: 'fact', sourceKind: 'file', sourceRef: 'src/x.ts', ...frontmatter }
  return `---\n${JSON.stringify(fm, null, 2)}\n---\n\n# ${String(frontmatter['title'] ?? 'Title')}\n\n${body}\n`
}

async function writeProjectFile(root: string, relPath: string, content: string): Promise<void> {
  const dir = relPath.split('/').slice(0, -1).join('/')
  await mkdir(join(root, dir), { recursive: true })
  await writeFile(join(root, relPath), content, 'utf8')
}

describe('flag gating', () => {
  it('treats only on (case/whitespace-insensitive) as on, everything else as off', () => {
    for (const value of ['on', 'ON', ' on ', '1', 'true']) {
      expect(memoryFilesEnabled({ [MEMORY_FILES_FLAG]: value })).toBe(true)
    }
    for (const value of ['yes', 'off', '', undefined]) {
      expect(memoryFilesEnabled({ [MEMORY_FILES_FLAG]: value })).toBe(false)
    }
  })

  it('export and rebuild touch no fs, git, or SQL when off', async () => {
    const { sql, runCalls } = indexFixture()
    const id = insertMemory(sql)
    const fake = fakePort(await tempDir())
    runCalls.length = 0

    expect(await writeMemoryFactFile(sql, HUMAN, id, fake.port)).toEqual({ status: 'disabled' })
    const report = await rebuildMemoryIndex(sql, fake.port)

    expect(report.status).toBe('disabled')
    expect(report.scanned).toBe(0)
    expect([fake.calls.length, fake.writes.length, fake.lists, fake.ensures, runCalls.length]).toEqual([0, 0, 0, 0, 0])
  })
})
describe('fs port', () => {
  it('writes atomically with mode 0600 and leaves no temp files', async () => {
    const root = await tempDir()
    const port = createMemoryFilePort(root)
    const target = join(root, 'p1/deploy-notes.md')
    await port.write('p1/deploy-notes.md', 'first')

    expect([(await stat(target)).mode & 0o777, await readFile(target, 'utf8')]).toEqual([0o600, 'first'])
    expect(await readdir(join(root, 'p1'))).toEqual(['deploy-notes.md'])

    await port.write('p1/deploy-notes.md', 'second')
    expect([(await stat(target)).mode & 0o777, await readFile(target, 'utf8')]).toEqual([0o600, 'second'])
  })

  it('lists regular files only, skipping .git and symlinks', async () => {
    const root = await tempDir()
    const port = createMemoryFilePort(root)
    await writeProjectFile(root, 'p1/a.md', 'a')
    await writeProjectFile(root, 'p1/nested/b.md', 'b')
    await mkdir(join(root, '.git'), { recursive: true })
    await writeFile(join(root, '.git/config'), 'x')
    await symlink(await tempDir('webterm-outside-'), join(root, 'p1/linked'), 'dir')
    expect(await port.list('')).toEqual(['p1/a.md', 'p1/nested/b.md'])
  })
})
describe('path containment', () => {
  it('refuses traversal and absolute paths, and neutralizes unsafe segments', () => {
    expect(() => resolveInside('/tmp/root', '../escape.md')).toThrow(/escapes root/)
    expect(() => resolveInside('/tmp/root', '/etc/passwd')).toThrow(/must be relative/)
    expect(() => resolveInside('/tmp/root', 'a\0b')).toThrow(/must be relative/)
    const rel = memoryFileRelPath('../../etc', '../../project', '../../secrets')
    expect(rel.includes('..')).toBe(false)
    expect(rel.endsWith('.md')).toBe(true)
    expect(memoryFileRelPath('p1', 'project', 'deploy')).toBe('p1/project/deploy.md')
    expect(memoryFileRelPath('p1', 'scratch', 'deploy')).toBe('p1/scratch/deploy.md')
    expect(safeSegment('deploy notes')).toMatch(/^deploy-notes-[0-9a-f]{10}$/)
    expect(safeSegment('deploy-notes')).toBe('deploy-notes')
  })

  it('rejects a symlinked project dir that escapes the root', async () => {
    const root = await tempDir()
    await mkdir(join(root, 'p1'), { recursive: true })
    await symlink(await tempDir('webterm-outside-'), join(root, 'p1/linked'), 'dir')
    await expect(assertConfined(root, 'p1/linked/x.md')).rejects.toThrow(/symlink/)
    await expect(assertConfined(root, 'p1/ok.md')).resolves.toBeUndefined()
  })

  it('export refuses to write through a symlinked directory', async () => {
    const { sql } = indexFixture()
    const id = insertMemory(sql)
    const root = await tempDir()
    const outside = await tempDir('webterm-outside-')
    await symlink(outside, join(root, 'p1'), 'dir')
    const fake = fakePort(root)

    await withFlag(async () => {
      await expect(writeMemoryFactFile(sql, HUMAN, id, fake.port)).rejects.toThrow(/symlink/)
    })
    expect([fake.writes.length, fake.calls.length, (await readdir(outside)).length]).toEqual([0, 0, 0])
  })
})
describe('export (writeMemoryFactFile)', () => {
  it('renders deterministic Markdown and commits one path with a safe argv', async () => {
    const { sql } = indexFixture()
    const id = insertMemory(sql, { key: 'deploy notes', body: 'token sk-live-abcdefghijklmnop\nsecond line' })
    sql.run('INSERT INTO memory_event (memory_id, ts, actor, kind, payload_json) VALUES (?,?,?,?,?)',
      id, T0, 'orch', 'memory.promote',
      JSON.stringify({ actorKind: 'orchestrator', evidence: { command: 'bun test', exitCode: 0, observedAt: T0, digest: 'a'.repeat(64) } }))
    const root = await tempDir()
    const fake = fakePort(root)

    const result = await withFlag(() => writeMemoryFactFile(sql, HUMAN, id, fake.port))

    expect(result.status).toBe('written')
    expect(result.relPath).toBe('p1/project/deploy-notes-63f292d70d.md')
    expect(fake.writes).toHaveLength(1)
    const content = fake.writes[0]!.content
    expect(content).not.toContain('sk-live-abcdefghijklmnop')
    expect(content).toContain('[redacted]')
    expect(content).toContain('"evidence": "sha256:')
    expect(content.startsWith('---\n{\n  "id": "m1"')).toBe(true)
    expect(content).toContain('\n# Deploy notes\n')

    expect(fake.calls.map((call) => call.file)).toEqual(['git', 'git'])
    // gitExec.ts prefix: no fsmonitor, no hooks.
    const SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null']
    expect(fake.calls[0]!.args).toEqual([...SAFE, 'add', '--', 'p1/project/deploy-notes-63f292d70d.md'])
    expect(fake.calls[1]!.args.slice(0, SAFE.length)).toEqual(SAFE)
    const commitArgs = fake.calls[1]!.args.slice(SAFE.length)
    expect(commitArgs.slice(0, 4)).toEqual(['-c', 'user.name=webterm', '-c', 'user.email=webterm@localhost'])
    expect(commitArgs.slice(4, 6)).toEqual(['commit', '-m'])
    expect(commitArgs.slice(7)).toEqual(['--only', '--', 'p1/project/deploy-notes-63f292d70d.md'])
    expect(commitArgs[6]).not.toMatch(/[\r\n\u0000-\u001f]/)
    expect(fake.calls.every((call) => call.cwd === root)).toBe(true)
  })

  it('is idempotent: identical content means no write and no commit', async () => {
    const { sql } = indexFixture()
    const id = insertMemory(sql)
    const existing = renderMemoryFile(memoryOf(), null)
    const fake = fakePort(await tempDir(), { content: existing })

    const result = await withFlag(() => writeMemoryFactFile(sql, HUMAN, id, fake.port))
    expect(result).toEqual({ status: 'unchanged', relPath: 'p1/project/deploy-notes.md', commit: null })
    expect([fake.writes.length, fake.calls.length]).toEqual([0, 0])
  })

  it('rejects workers, non-human core, and non-fact rows', async () => {
    const { sql } = indexFixture()
    const id = insertMemory(sql)
    const coreId = insertMemory(sql, { id: 'm2', key: 'core-rule', scope: 'core' })
    const claimId = insertMemory(sql, { id: 'm3', key: 'pending', status: 'claim' })
    const port = fakePort(await tempDir()).port

    await withFlag(async () => {
      await expect(writeMemoryFactFile(sql, WORKER, id, port)).rejects.toThrow(MemoryAuthorityError)
      await expect(writeMemoryFactFile(sql, ORCH, coreId, port)).rejects.toThrow(MemoryAuthorityError)
      await expect(writeMemoryFactFile(sql, HUMAN, coreId, port)).rejects.toThrow(MemoryAuthorityError)
      await expect(writeMemoryFactFile(sql, HUMAN, claimId, port)).rejects.toThrow(MemoryConflictError)
      await expect(writeMemoryFactFile(sql, HUMAN, 'missing', port)).rejects.toThrow(MemoryConflictError)
    })
  })

  it('keeps the commit subject on one sanitized line', () => {
    const message = memoryCommitMessage(memoryOf({ key: 'line\nbreak\u0001inject' }))
    expect(message).not.toMatch(/[\r\n\u0000-\u001f]/)
    expect(message).toBe('memory(p1): record fact line break inject')
  })
})

describe('rebuild (rebuildMemoryIndex)', () => {
  it('is files-win and idempotent, inserting new facts and preserving superseded history', async () => {
    const { sql } = indexFixture()
    insertMemory(sql, { body: 'stale body' })
    insertMemory(sql, { id: 'm-old', key: 'old#superseded:m-old', status: 'superseded', title: 'Old' })
    const root = await tempDir()
    await writeProjectFile(root, 'p1/project/deploy-notes.md',
      memoryMd({ id: 'm1', projectId: 'p1', scope: 'project', key: 'deploy-notes', title: 'Deploy notes', updatedAt: T0 + 5 }, 'fresh body'))
    await writeProjectFile(root, 'p1/project/release.md',
      memoryMd({ id: 'm-rel', projectId: 'p1', scope: 'project', key: 'release', title: 'Release', updatedAt: T0 + 6 }, 'release body'))
    await writeProjectFile(root, 'p1/notes.txt', 'ignored')

    const first = await withFlag(() => rebuildMemoryIndex(sql, createMemoryFilePort(root)))
    expect([first.status, first.scanned, first.inserted, first.updated, first.unchanged]).toEqual(['rebuilt', 2, 1, 1, 0])
    expect(first.rejected).toEqual([])

    const row = sql.all("SELECT * FROM memory WHERE project_id = 'p1' AND key = 'deploy-notes'")[0]!
    expect(row['body']).toBe('fresh body')
    expect(row['id']).toBe('m1')
    expect([Number(row['updated_at']), row['status']]).toEqual([T0 + 5, 'fact'])
    expect(sql.all("SELECT status FROM memory WHERE key = 'old#superseded:m-old'")[0]!['status']).toBe('superseded')

    const second = await withFlag(() => rebuildMemoryIndex(sql, createMemoryFilePort(root)))
    expect([second.inserted, second.updated, second.unchanged]).toEqual([0, 0, 2])
    expect(sql.all("SELECT id FROM memory WHERE key IN ('deploy-notes','release')")).toHaveLength(2)
  })

  it('quarantines conflicting files instead of silently overwriting', async () => {
    const { sql } = indexFixture()
    insertMemory(sql, { body: 'index body' })
    const root = await tempDir()
    const fm = { id: 'm1', projectId: 'p1', scope: 'project', key: 'deploy-notes', title: 'Deploy notes', updatedAt: T0 }
    await writeProjectFile(root, 'p1/one.md', memoryMd(fm, 'file one'))
    await writeProjectFile(root, 'p1/two.md', memoryMd(fm, 'file two'))

    const report = await withFlag(() => rebuildMemoryIndex(sql, createMemoryFilePort(root)))
    expect(report.quarantined).toEqual(['p1/one.md', 'p1/two.md'])
    expect(report.inserted + report.updated + report.unchanged).toBe(0)
    const row = sql.all("SELECT id FROM memory WHERE project_id = 'p1' AND key = 'deploy-notes'")[0]!
    expect(sql.all('SELECT status FROM memory WHERE id = ?', String(row['id']))[0]!['status']).toBe('quarantine')
    const kinds = sql.all('SELECT kind FROM memory_event WHERE memory_id = ?', String(row['id'])).map((r) => r['kind'])
    expect(kinds).toContain('memory.rebuild.quarantine')
  })

  it('rejects invalid frontmatter and core-scope files', async () => {
    const { sql } = indexFixture()
    const root = await tempDir()
    await writeProjectFile(root, 'p1/bad.md', '---\n{"id":"x"}\n---\n\nbody\n')
    await writeProjectFile(root, 'p1/notjson.md', '---\nnot json\n---\n\nbody\n')
    await writeProjectFile(root, 'p1/core.md',
      memoryMd({ id: 'm-core', projectId: 'p1', scope: 'core', key: 'core', title: 'Core', updatedAt: T0 }, 'rule'))
    await writeProjectFile(root, 'p1/claim.md',
      memoryMd({ id: 'm-c', projectId: 'p1', scope: 'project', key: 'c', title: 'C', status: 'claim', updatedAt: T0 }, 'x'))

    const report = await withFlag(() => rebuildMemoryIndex(sql, createMemoryFilePort(root)))
    expect(report.scanned).toBe(0)
    expect(report.rejected.map((entry) => entry.file).sort())
      .toEqual(['p1/bad.md', 'p1/claim.md', 'p1/core.md', 'p1/notjson.md'])
    expect(report.rejected.find((entry) => entry.file === 'p1/core.md')!.reason).toMatch(/human-only/)
    expect(report.rejected.find((entry) => entry.file === 'p1/notjson.md')!.reason).toMatch(/not valid JSON/)
  })

  it('limits the rebuild to one project when asked', async () => {
    const { sql } = indexFixture()
    ensureProject(sql, 'p1')
    ensureProject(sql, 'p2')
    const root = await tempDir()
    await writeProjectFile(root, 'p1/a.md',
      memoryMd({ id: 'm-a', projectId: 'p1', scope: 'project', key: 'a', title: 'A', updatedAt: T0 }, 'a'))
    await writeProjectFile(root, 'p2/b.md',
      memoryMd({ id: 'm-b', projectId: 'p2', scope: 'project', key: 'b', title: 'B', updatedAt: T0 }, 'b'))

    const report = await withFlag(() => rebuildMemoryIndex(sql, createMemoryFilePort(root), 'p2'))
    expect([report.projectId, report.scanned, report.inserted]).toEqual(['p2', 1, 1])
    expect(sql.all("SELECT id FROM memory WHERE project_id = 'p1'")).toHaveLength(0)
  })

  // D1: the DB key is unique per (project, scope, key); a flat path would collide.
  it('keeps facts that differ only by scope on distinct paths and restores both', async () => {
    const { sql } = indexFixture()
    const proj = insertMemory(sql, { id: 'm-proj', scope: 'project', key: 'deploy', body: 'project body' })
    const scratch = insertMemory(sql, { id: 'm-scratch', scope: 'scratch', key: 'deploy', body: 'scratch body' })
    const port = createMemoryFilePort(await tempDir(), async () => ({ code: 0, stdout: '', stderr: '' }))

    const first = await withFlag(() => writeMemoryFactFile(sql, HUMAN, proj, port))
    const second = await withFlag(() => writeMemoryFactFile(sql, HUMAN, scratch, port))

    expect([first.relPath, second.relPath]).toEqual(['p1/project/deploy.md', 'p1/scratch/deploy.md'])
    expect(await port.read('p1/project/deploy.md')).toContain('project body')
    expect(await port.read('p1/scratch/deploy.md')).toContain('scratch body')

    const cold = indexFixture()
    ensureProject(cold.sql, 'p1')
    const report = await withFlag(() => rebuildMemoryIndex(cold.sql, port))
    expect([report.inserted, report.quarantined]).toEqual([2, []])
    expect(cold.sql.all("SELECT scope, body FROM memory WHERE key = 'deploy' ORDER BY scope").map((row) => [row['scope'], row['body']]))
      .toEqual([['project', 'project body'], ['scratch', 'scratch body']])
  })

  // D2: a file written before a supersede must not roll the live row back.
  it('never lets a stale file revert a newer fact', async () => {
    const { sql } = indexFixture()
    const id = insertMemory(sql, { body: 'OLD body' })
    const port = createMemoryFilePort(await tempDir(), async () => ({ code: 0, stdout: '', stderr: '' }))
    await withFlag(async () => { await writeMemoryFactFile(sql, HUMAN, id, port) })

    // Same shape as supersedeMemory: old row keeps history under an alias, live row is newer.
    sql.run("UPDATE memory SET key = ?, status = 'superseded', superseded_at = ?, updated_at = ? WHERE id = ?",
      `deploy-notes#superseded:${id}`, T0 + 1000, T0 + 1000, id)
    insertMemory(sql, { id: 'm2', body: 'NEW body', updatedAt: T0 + 1000 })

    const report = await withFlag(() => rebuildMemoryIndex(sql, port))
    expect([report.updated, report.quarantined]).toEqual([0, []])
    expect(report.unchanged).toBe(1)
    const live = sql.all("SELECT id, body FROM memory WHERE key = 'deploy-notes'")[0]!
    expect([live['id'], live['body']]).toEqual(['m2', 'NEW body'])
  })
})

describe('rendering', () => {
  it('round-trips frontmatter and body without leaking evidence into the body', () => {
    const record = parseMemoryFile(renderMemoryFile(memoryOf(), `sha256:${'b'.repeat(64)}`))
    expect(record.body).toBe('old body')
    expect(record.evidence).toBe(`sha256:${'b'.repeat(64)}`)
    expect(record.sourceKind).toBe('file')
  })
})

function hasGit(): Promise<boolean> {
  return new Promise((resolvePromise) => execFile('git', ['--version'], (err) => resolvePromise(err === null)))
}
const GIT = await hasGit()

function runProcess(file: string, args: string[], cwd: string): Promise<MemoryFileExecResult> {
  return new Promise((resolvePromise) => {
    execFile(file, args, { cwd }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof err.code === 'number' ? err.code : 1
      resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

describe('real git integration', () => {
  it.skipIf(!GIT)('writes the file and commits exactly that path', async () => {
    const { sql } = indexFixture()
    const id = insertMemory(sql)
    const root = await tempDir()
    const run = (file: string, args: string[], cwd: string) => runProcess(file, args, cwd)
    expect((await run('git', ['init', '-q'], root)).code).toBe(0)
    await run('git', ['config', 'user.email', 'agent@webterm.test'], root)
    await run('git', ['config', 'user.name', 'webterm test'], root)
    await writeFile(join(root, 'README.md'), 'seed\n')
    expect((await run('git', ['add', '--', 'README.md'], root)).code).toBe(0)
    expect((await run('git', ['commit', '-q', '-m', 'seed'], root)).code).toBe(0)

    const result = await withFlag(() => writeMemoryFactFile(sql, ORCH, id, createMemoryFilePort(root, run)))
    expect([result.status, result.relPath]).toEqual(['written', 'p1/project/deploy-notes.md'])
    expect((await run('git', ['status', '--porcelain'], root)).stdout.trim()).toBe('')
    expect((await run('git', ['log', '-1', '--format=%s'], root)).stdout.trim())
      .toBe('memory(p1): record fact deploy-notes')
    expect((await run('git', ['show', '--name-only', '--format=', 'HEAD'], root)).stdout.trim()).toBe('p1/project/deploy-notes.md')
    expect((await stat(join(root, 'p1/project/deploy-notes.md'))).mode & 0o777).toBe(0o600)
  })
})
