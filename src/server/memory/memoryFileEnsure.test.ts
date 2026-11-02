// D3: the memory root and its git repo are created on demand, so the write path works on a
// fresh install (no operator mkdir / git init) and a commit never needs host git config.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { DDL_V1 } from '../ledger/ledgerSchemaV1'
import { type MemoryAuthority } from './memoryModel'
import {
  MEMORY_FILES_FLAG, type MemoryFileExecResult, type MemorySqlDb,
  createMemoryFilePort, memorySqlDb, rebuildMemoryIndex, writeMemoryFactFile,
} from './memoryFile'

const T0 = 1_700_000_000_000
const HUMAN: MemoryAuthority = { kind: 'human', id: 'human-1' }
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

function indexFixture(): MemorySqlDb {
  const db = new DatabaseSync(':memory:')
  db.exec(DDL_V1)
  return memorySqlDb({
    all: (text, ...p) => (db.prepare(text) as unknown as { all(...a: unknown[]): Record<string, unknown>[] }).all(...p),
    run: (text, ...p) => (db.prepare(text) as unknown as { run(...a: unknown[]): unknown }).run(...p),
  })
}

/** One fact under project p1, ready to export. */
function insertFact(sql: MemorySqlDb, id = 'm1'): string {
  sql.run('INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    'p1', 'w-p1', 'p1', '/tmp/p1', T0, T0)
  sql.run(
    `INSERT INTO memory (id, project_id, scope, key, title, body, status, source_kind, source_ref,
       supersedes, created_at, updated_at) VALUES (?,?,?,?,?,?,'fact','file','src/x.ts',NULL,?,?)`,
    id, 'p1', 'project', 'deploy-notes', 'Deploy notes', 'old body', T0, T0
  )
  return id
}

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

describe('cold install (port.ensure)', () => {
  it('creates the root 0700, runs git init, and exports', async () => {
    const sql = indexFixture()
    const id = insertFact(sql)
    const root = join(await tempDir(), 'data', 'memory')
    const calls: string[][] = []
    const port = createMemoryFilePort(root, async (_file, args) => {
      calls.push(args)
      return { code: 0, stdout: '', stderr: '' }
    })

    // Rebuild never creates the repo: a missing root simply scans nothing.
    const cold = await withFlag(() => rebuildMemoryIndex(sql, port))
    expect([cold.status, cold.scanned]).toEqual(['rebuilt', 0])
    expect(calls).toEqual([])

    const result = await withFlag(() => writeMemoryFactFile(sql, HUMAN, id, port))
    expect([result.status, result.relPath]).toEqual(['written', 'p1/project/deploy-notes.md'])
    // The fake spawn never creates `.git`, so every call re-runs the (idempotent) init.
    expect(calls.slice(0, 2)).toEqual([
      ['init', '-q'], ['add', '--', 'p1/project/deploy-notes.md'],
    ])
    expect(calls[2]!.slice(4)).toEqual([
      'commit', '-m', 'memory(p1): record fact deploy-notes', '--only', '--', 'p1/project/deploy-notes.md',
    ])
    expect((await stat(root)).mode & 0o777).toBe(0o700)
    expect(await readFile(join(root, 'p1/project/deploy-notes.md'), 'utf8')).toContain('"key": "deploy-notes"')
  })

  it('skips git init once .git exists', async () => {
    const root = await tempDir()
    let inits = 0
    const port = createMemoryFilePort(root, async (_file, args) => {
      if (args[0] === 'init') {
        inits += 1
        await mkdir(join(root, '.git'), { recursive: true })
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    await port.ensure!()
    await port.ensure!()
    expect(inits).toBe(1)
  })

  it('stays inert, with no directory, when the flag is off', async () => {
    const sql = indexFixture()
    const id = insertFact(sql)
    const off = createMemoryFilePort(join(await tempDir(), 'never'))
    expect(await writeMemoryFactFile(sql, HUMAN, id, off, false)).toEqual({ status: 'disabled' })
    expect((await rebuildMemoryIndex(sql, off, undefined, false)).status).toBe('disabled')
    await expect(stat(off.root)).rejects.toThrow()
  })

  it.skipIf(!GIT)('exports on a cold root with a real git init and a server-owned identity', async () => {
    const sql = indexFixture()
    const id = insertFact(sql)
    const root = join(await tempDir(), 'memory')
    const result = await withFlag(() => writeMemoryFactFile(sql, HUMAN, id, createMemoryFilePort(root, runProcess)))
    expect(result.status).toBe('written')
    expect((await runProcess('git', ['log', '-1', '--format=%ae'], root)).stdout.trim()).toBe('webterm@localhost')
  })
})
