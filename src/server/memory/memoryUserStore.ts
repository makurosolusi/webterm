/**
 * Markdown files for `user` memory, the source of truth that lives OUTSIDE git (decision P4):
 * `<WEBTERM_MEMORY_DIR>/user/<key>.md` plus a root `.gitignore` entry, so the project-facts repo
 * never commits personal data and deleting a file really deletes it. SQLite is the rebuildable index.
 * `formatVersion` 2 is always written; files without the field (v1) still parse.
 */
import type { Database } from 'bun:sqlite'
import { rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { allRows, getRow, tx } from '../ledger/ledgerCore'
import { redactSecrets } from '../redactSecrets'
import { contentHash } from './memoryConsolidate'
import { memoryContext, appendMemoryEvent } from './memoryCore'
import { type MemoryFilePort, resolveInside, safeSegment } from './memoryFilePath'
import { findRowByKey, insertMemoryRow } from './memoryInsert'
import { quarantineMemory } from './memoryWrite'
import { MemoryAuthorityError, MemoryRejectedError, type MemoryAuthority, type MemoryKind, type MemoryRecord } from './memoryModel'

export const USER_MEMORY_FORMAT_VERSION = 2
const USER_DIR = 'user'
const GITIGNORE = '.gitignore'
const GITIGNORE_ENTRY = '/user/'
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

export interface UserMemoryFile {
  id: string
  key: string
  title: string
  kind: MemoryKind
  trust: 'attested' | 'human'
  sourceRef: string
  updatedAt: number
  body: string
}

/** Port used by `rememberUser`; the real one is backed by files, tests may inject a fake. */
export interface UserMemoryStore {
  write(file: UserMemoryFile): Promise<void>
  remove(key: string): Promise<void>
  /** Parsed files plus the relative paths that could not be parsed. */
  list(): Promise<{ files: UserMemoryFile[]; rejected: string[] }>
}

/** `WEBTERM_MEMORY_DIR` when absolute, else `<dataDir>/memory`; a relative value is ignored, never resolved against cwd. */
export function userMemoryRoot(env: Record<string, string | undefined>, dataDirPath: string): string {
  const configured = env['WEBTERM_MEMORY_DIR']?.trim() ?? ''
  return configured !== '' && isAbsolute(configured) ? configured : join(dataDirPath, 'memory')
}

const relPathOf = (key: string): string => `${USER_DIR}/${safeSegment(key)}.md`

/** Deterministic file text: ordered JSON frontmatter, blank line, body (secrets redacted). */
export function renderUserMemoryFile(file: UserMemoryFile): string {
  const fm = { formatVersion: USER_MEMORY_FORMAT_VERSION, id: file.id, scope: 'user', key: file.key, title: file.title,
    kind: file.kind, trust: file.trust, sourceRef: file.sourceRef, updatedAt: file.updatedAt }
  return `---\n${JSON.stringify(fm, null, 2)}\n---\n\n${redactSecrets(file.body).replace(/\s+$/, '')}\n`
}

/** Parses one user file; throws a coded rejection on any structural problem. */
export function parseUserMemoryFile(text: string): UserMemoryFile {
  const match = FRONTMATTER.exec(text)
  if (match === null) throw new MemoryRejectedError('invalid_file', 'user memory file has no frontmatter')
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(match[1]) as Record<string, unknown>
  } catch (err) {
    throw new MemoryRejectedError('invalid_file', `user memory frontmatter is not JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  const str = (name: string): string => {
    const v = raw[name]
    if (typeof v !== 'string' || v.trim() === '') throw new MemoryRejectedError('invalid_file', `frontmatter.${name} must be a non-empty string`)
    return v
  }
  if (raw['scope'] !== 'user') throw new MemoryRejectedError('invalid_file', 'frontmatter.scope must be user')
  if (typeof raw['updatedAt'] !== 'number') throw new MemoryRejectedError('invalid_file', 'frontmatter.updatedAt must be epoch-ms')
  const body = text.slice(match[0].length).trim()
  if (body === '') throw new MemoryRejectedError('invalid_file', 'user memory file has an empty body')
  // A hand-edited file may be `human`; anything else (including a forged higher rank) is read as attested.
  return { id: str('id'), key: str('key'), title: str('title'), kind: str('kind') as MemoryKind,
    trust: raw['trust'] === 'human' ? 'human' : 'attested', sourceRef: typeof raw['sourceRef'] === 'string' ? raw['sourceRef'] : '',
    updatedAt: raw['updatedAt'], body }
}

/** File-backed store over a `MemoryFilePort` rooted at the memory dir. */
export function createUserMemoryStore(port: MemoryFilePort): UserMemoryStore {
  let guarded = false
  async function ensureGitignore(): Promise<void> {
    if (guarded) return
    const current = (await port.read(GITIGNORE)) ?? ''
    if (!current.split(/\r?\n/).includes(GITIGNORE_ENTRY)) {
      await port.write(GITIGNORE, `${current}${current === '' || current.endsWith('\n') ? '' : '\n'}${GITIGNORE_ENTRY}\n`)
    }
    guarded = true
  }
  return {
    async write(file) {
      await ensureGitignore()
      await port.write(relPathOf(file.key), renderUserMemoryFile(file))
    },
    async remove(key) {
      await rm(resolveInside(port.root, relPathOf(key)), { force: true })
    },
    async list() {
      const files: UserMemoryFile[] = []
      const rejected: string[] = []
      for (const rel of await port.list(USER_DIR)) {
        if (!rel.endsWith('.md')) continue
        try {
          files.push(parseUserMemoryFile((await port.read(rel)) ?? ''))
        } catch (err) {
          if (!(err instanceof MemoryRejectedError)) throw err
          rejected.push(rel)
        }
      }
      return { files, rejected }
    },
  }
}

/**
 * Files win: imports files whose id and key are unknown to SQLite. Existing rows (any status,
 * including quarantined) are left alone so a revoked memory cannot come back from a stale copy.
 */
export async function rebuildUserMemory(db: Database, store: UserMemoryStore, now: number): Promise<{ imported: number; skipped: number; rejected: number }> {
  const { files, rejected } = await store.list()
  let imported = 0
  let skipped = 0
  for (const file of files) {
    const known = getRow(db, 'SELECT 1 AS one FROM memory WHERE id = ?', file.id) !== null || findRowByKey(db, null, 'user', file.key) !== null
    if (known) { skipped += 1; continue }
    tx(memoryContext(db, now), () => {
      insertMemoryRow(db, { id: file.id, projectId: null, scope: 'user', key: file.key, title: file.title, body: file.body,
        status: 'fact', kind: file.kind, trust: file.trust, sourceKind: 'user_file', sourceRef: file.sourceRef, supersedes: null,
        contentHash: contentHash(file.title, file.body), staleAfter: null, verifiedAt: now, now })
      appendMemoryEvent(memoryContext(db, now), file.id, 'system:rebuild', 'memory.rebuild', { from: 'file' }, now)
    })
    imported += 1
  }
  return { imported, skipped, rejected: rejected.length }
}

/** One-click undo: a human quarantines an attested user memory and its file is removed. */
export async function revokeUserMemory(db: Database, store: UserMemoryStore, authority: MemoryAuthority, id: string, reason: string): Promise<MemoryRecord> {
  if (authority.kind !== 'human') throw new MemoryAuthorityError('revokeUserMemory: only a human may revoke user memory')
  const row = allRows(db, "SELECT key FROM memory WHERE id = ? AND scope = 'user'", id)[0]
  if (row === undefined) throw new MemoryRejectedError('not_found', `user memory not found: ${id}`)
  quarantineMemory(db, authority, { id, reason })
  await store.remove(String(row['key']))
  return findRowByKey(db, null, 'user', String(row['key'])) as MemoryRecord
}
