// Retention for `central_skill`: a rejected proposal is dropped 30 days after it was proposed, together
// with its `proposed/<name>/<version>` folder. The folder goes first; when it cannot be removed the row
// stays (the next proposal of that name would otherwise collide with the leftover folder, since
// proposeSkill writes with `wx`). Every path comes from skillDir (validated name and integer version)
// and is checked to sit inside `<root>/proposed/` before anything is removed.
import { rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { dataDir } from '../config'
import { skillDir } from '../central/skills/skillIndex'
import { createLogger } from '../logs'
import { allRows, execWrite, getRow, type LedgerContext } from './ledgerCore'

const log = createLogger('ledger')
/** Rejected skill proposals are kept this long (the reject reason shows in the skills view meanwhile). */
export const SKILL_REJECTED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/** Skills root as ca2Boot.ts builds it (`<data dir>/central/skills`). */
export const defaultSkillsRoot = (): string => join(dataDir(), 'central', 'skills')

/** Returns the folder to remove, or null when the row's name/version would leave `<root>/proposed/`. */
export function proposedDirInside(root: string, name: string, version: string): string | null {
  let dir: string
  try { dir = resolve(skillDir(root, 'proposed', name, version)) } catch { return null } // invalid name/version: never a path
  return dir.startsWith(resolve(root, 'proposed') + sep) ? dir : null
}

/** Deletes at most `limit` rejected proposals older than the retention, folder first. */
export function sweepRejectedSkills(ctx: LedgerContext, now: number, limit: number, root: string = defaultSkillsRoot()): number {
  // The table is created lazily by the skill store; no table means nothing to sweep.
  if (!getRow(ctx.db, "SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = 'central_skill'")) return 0
  const rows = allRows(ctx.db, "SELECT name, version FROM central_skill WHERE status = 'rejected' AND created_at < ? LIMIT ?", now - SKILL_REJECTED_RETENTION_MS, limit)
  let n = 0
  for (const r of rows) {
    const name = String(r['name'])
    const version = String(r['version'])
    const dir = proposedDirInside(root, name, version)
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch (err) {
        log.warn('ledger.retention.skill_dir', `cannot remove rejected skill folder ${name}@${version}; row kept`, { error: err instanceof Error ? err.message : String(err) })
        continue
      }
    }
    n += execWrite(ctx.db, "DELETE FROM central_skill WHERE name = ? AND version = ? AND status = 'rejected'", name, version)
  }
  return n
}
