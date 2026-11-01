import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import type { LedgerRuntime } from './ledger/ledgerRuntime'
import type { MemoryFilePort, MemorySqlDb } from './memory/memoryFile'
import type { Row } from './ledger/ledgerCore'
import {
  MEMORY_FILE_AUTHORITY,
  MEMORY_EXPORT_PATH,
  MEMORY_REBUILD_PATH,
  memoryFileHttpRoute,
  type MemoryFileHttpDeps,
} from './memoryFileHttp'

const MEMORY_ROW = {
  id: 'm1',
  project_id: 'p1',
  scope: 'project',
  key: 'k1',
  title: 'Title',
  body: 'secret body text',
  status: 'fact',
  source_kind: null,
  source_ref: null,
  supersedes: null,
  superseded_at: null,
  created_at: 1,
  updated_at: 2,
}

function fakeDb(rows: Row[] = [MEMORY_ROW]): MemorySqlDb {
  return {
    all: (_sql: string, ...params: unknown[]) =>
      params[0] === 'm1' && rows.length > 0 ? rows : [],
    run: () => undefined,
  }
}

function fakePort(files: Record<string, string> = {}): { port: MemoryFilePort; writes: string[] } {
  const writes: string[] = []
  return {
    writes,
    port: {
      root: resolve(process.cwd()),
      read: async (relPath) => files[relPath] ?? null,
      write: async (relPath) => {
        writes.push(relPath)
      },
      list: async () => Object.keys(files).sort(),
      exec: async () => ({ code: 0, stdout: '[main abc] memory: record fact', stderr: '' }),
    },
  }
}

function runtime(db: MemorySqlDb): LedgerRuntime {
  return { db, mode: 'on', path: ':memory:', ledger: {} } as unknown as LedgerRuntime
}

const originalFlag = process.env.WEBTERM_MEMORY_FILES
const originalDir = process.env.WEBTERM_MEMORY_DIR

beforeEach(() => {
  // `writeMemoryFactFile` re-checks the process flag itself; the route-level `enabled` is
  // only the HTTP gate. Tests pin both so the real memory-file code runs.
  process.env.WEBTERM_MEMORY_FILES = 'on'
})
afterEach(() => {
  if (originalFlag === undefined) delete process.env.WEBTERM_MEMORY_FILES
  else process.env.WEBTERM_MEMORY_FILES = originalFlag
  if (originalDir === undefined) delete process.env.WEBTERM_MEMORY_DIR
  else process.env.WEBTERM_MEMORY_DIR = originalDir
})

function call(
  path: string,
  method = 'POST',
  body: unknown = {},
  overrides: Partial<MemoryFileHttpDeps> = {}
) {
  return memoryFileHttpRoute(path, method, body, {
    ledger: runtime(fakeDb()),
    enabled: true,
    env: process.env,
    dataDir: () => '/tmp/data',
    port: fakePort().port,
    ...overrides,
  })
}

describe('memory file HTTP surface', () => {
  it('claims only export/rebuild and requires POST', async () => {
    expect(await call('/api/memory')).toBeNull()
    expect((await call(MEMORY_EXPORT_PATH, 'GET'))?.status).toBe(405)
  })

  it('answers 503 when the flag or ledger is off', async () => {
    expect(await call(MEMORY_EXPORT_PATH, 'POST', { id: 'm1' }, { enabled: false })).toEqual({
      status: 503,
      body: { error: 'memory_files_off' },
    })
    expect(
      await call(MEMORY_EXPORT_PATH, 'POST', { id: 'm1' }, { enabled: true, ledger: null })
    ).toEqual({ status: 503, body: { error: 'ledger_off' } })
  })

  it('validates ids and bodies before touching files', async () => {
    expect((await call(MEMORY_EXPORT_PATH, 'POST', {}))?.status).toBe(400)
    expect((await call(MEMORY_EXPORT_PATH, 'POST', { id: 'x'.repeat(201) }))?.status).toBe(400)
    expect((await call(MEMORY_EXPORT_PATH, 'POST', []))?.status).toBe(400)
    expect((await call(MEMORY_REBUILD_PATH, 'POST', { projectId: ' ' }))?.status).toBe(400)
  })

  it('exports one fact as Markdown without echoing its body', async () => {
    const { port, writes } = fakePort()
    const result = await call(MEMORY_EXPORT_PATH, 'POST', { id: 'm1' }, { port })
    expect(result?.status).toBe(200)
    expect(result?.body).toMatchObject({ ok: true, status: 'written', relPath: 'p1/k1.md' })
    expect(writes).toEqual(['p1/k1.md'])
    expect(JSON.stringify(result?.body)).not.toContain('secret body text')
  })

  it('uses the fixed human/root authority and reports conflicts compactly', async () => {
    expect(MEMORY_FILE_AUTHORITY).toEqual({ kind: 'human', id: 'root' })
    const conflict = await call(MEMORY_EXPORT_PATH, 'POST', { id: 'missing' }, { port: fakePort().port })
    expect(conflict?.status).toBe(409)
    expect(conflict?.body).toMatchObject({ error: 'memory_conflict' })
  })

  it('rebuilds the index from files and reports counts, not contents', async () => {
    const files = {
      'p1/k1.md': 'not a memory file',
      'p1/k2.md': '---\n{"bad":true}\n---\n\n# x\n\nbody',
    }
    const result = await call(MEMORY_REBUILD_PATH, 'POST', {}, { port: fakePort(files).port })
    expect(result?.status).toBe(200)
    expect(result?.body).toMatchObject({ ok: true, status: 'rebuilt', scanned: 0, rejectedCount: 2 })
    expect(JSON.stringify(result?.body)).not.toContain('not a memory file')
  })
})
