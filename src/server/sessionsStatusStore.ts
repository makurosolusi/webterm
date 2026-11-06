import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { NodeStatusEntry } from './nodeRegistry'
import { createLogger } from './logs'

const log = createLogger('pty')

/** File name under the data dir. Holds node ids and status words only, never output or prompts. */
export const NODE_STATUS_FILE = 'node-status.json'

const STATUS_WORDS = new Set(['working', 'waiting', 'blocked', 'done', 'failed', 'stopped'])

const isEntry = (v: unknown): v is NodeStatusEntry =>
  !!v && typeof v === 'object' &&
  STATUS_WORDS.has((v as NodeStatusEntry).status) && Number.isFinite((v as NodeStatusEntry).updatedAt)

/**
 * Last agent status per node, kept on disk so a tmux session adopted after a server restart shows
 * the status it had (agent-211-A4) instead of Unknown until its next hook. One small JSON snapshot,
 * rewritten atomically (tmp + rename) on every status change; the stale sweep keeps a restored
 * `working` honest. A read or write failure is logged and never stops the server.
 */
export class StatusStore {
  constructor(readonly path: string) {}

  load(): Map<string, NodeStatusEntry> {
    const out = new Map<string, NodeStatusEntry>()
    if (!existsSync(this.path)) return out
    try {
      const raw: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
      if (raw && typeof raw === 'object') {
        for (const [id, entry] of Object.entries(raw)) if (isEntry(entry)) out.set(id, { status: entry.status, updatedAt: entry.updatedAt })
      }
    } catch (err) {
      log.warn('pty.status_load_failed', 'agent status snapshot unreadable; statuses start empty', { error: (err as Error).name, code: (err as NodeJS.ErrnoException).code })
    }
    return out
  }

  save(entries: Iterable<[string, NodeStatusEntry]>): void {
    const tmp = `${this.path}.${process.pid}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(entries)), { mode: 0o600 })
      renameSync(tmp, this.path)
    } catch (err) {
      log.warn('pty.status_save_failed', 'agent status snapshot not written', { error: (err as Error).name, code: (err as NodeJS.ErrnoException).code })
    }
  }
}
