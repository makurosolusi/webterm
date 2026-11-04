// Where the channel store document lives. Two backends behind one tiny seam: the ledger row
// (production, channelStoreLedger.ts) and the legacy JSON file (node-env tests, which cannot load
// bun:sqlite, and the one-time import source). Both deal in the raw document string; validation
// stays in channelStoreSchema.ts so a backend can never weaken the fail-closed rule.
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { backupStoreV1 } from './channelStoreMigrate'

export const MAX_STORE_BYTES = 4 * 1024 * 1024

/** Thrown by a backend; the store maps it to `ChannelStoreError` with the backend's location. */
export class PersistError extends Error {
  constructor(readonly code: 'read_failed' | 'write_failed') {
    super(code)
    this.name = 'PersistError'
  }
}

export interface ChannelStorePersistence {
  /** Path or `ledger:<file>`, for error messages only (never content). */
  readonly location: string
  /** Raw document, or null when nothing is stored yet. */
  read(): string | null
  /** True when `read` returned a document that is not yet in this backend (legacy import). */
  readonly pendingImport: boolean
  /** Durable, atomic replace of the whole document. */
  write(doc: string): void
  /** Keep the v1 original before the first v2 write. */
  backupV1(): void
}

function ensureDir(path: string): void {
  const dir = dirname(path)
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    // mkdir's mode is filtered by umask, so assert the final mode explicitly.
    if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700)
  } catch {
    throw new PersistError('write_failed')
  }
}

/** Reads a JSON store file (size-capped); null when absent. */
export function readStoreFile(path: string): string | null {
  if (!existsSync(path)) return null
  try {
    if (statSync(path).size > MAX_STORE_BYTES) throw new Error('too_large')
    return readFileSync(path, 'utf8')
  } catch {
    throw new PersistError('read_failed')
  }
}

/** Atomic write: fsync tmp, rename over the target, then force 0600 on the final file. */
function writeStoreFile(path: string, doc: string): void {
  ensureDir(path)
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(tmp, 'wx', 0o600)
    writeSync(fd, doc)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tmp, path)
    chmodSync(path, 0o600)
  } catch {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // fd was already closed by the failure path; nothing to recover.
      }
    }
    try {
      unlinkSync(tmp)
    } catch {
      // tmp was never created or was already renamed; nothing to clean up.
    }
    throw new PersistError('write_failed')
  }
}

/** File backend (mode 0600 file in a 0700 directory). */
export function filePersistence(path: string): ChannelStorePersistence {
  return {
    location: path,
    pendingImport: false,
    read() {
      const raw = readStoreFile(path)
      if (raw === null) ensureDir(path)
      return raw
    },
    write: (doc) => writeStoreFile(path, doc),
    backupV1() {
      try {
        backupStoreV1(path)
      } catch {
        throw new PersistError('write_failed')
      }
    },
  }
}
