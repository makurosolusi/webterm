// Auto-done is never flipped on silently. A project that existed before the default (auto_done 0) gets one offer
// notice whose action enables it; a project that is on (new projects default on) gets one notice saying so. Each
// project is considered once (the `auto_done_seen` setting), and a human toggle counts as seen, so a project the
// user turned off is never offered again.
import type { Database } from 'bun:sqlite'
import { recordEvent } from '../../events/producers'
import { allRows } from '../../ledger/ledgerCore'
import { automaticAction } from '../automaticAction'
import { readCentralSetting, writeCentralSetting } from '../centralSetting'

const SEEN = 'auto_done_seen'
/** The switch's endpoint (ca2Routes.work.ts); the offer's action posts here. */
export const WORK_SETTINGS_PATH = '/api/central/work-settings'
// ponytail: one JSON array of project ids; a per-project column if installs ever hold thousands of projects.
const PROJECTS_MAX = 1000

const seenSet = (db: Database): Set<string> => {
  const v = readCentralSetting(db, SEEN)
  return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
}
const markSeen = (db: Database, ids: Iterable<string>, actor: string, at: number): void => {
  const seen = seenSet(db)
  const before = seen.size
  for (const id of ids) seen.add(id)
  if (seen.size !== before) writeCentralSetting(db, SEEN, [...seen].sort(), actor, at)
}

/** A human set the switch: the record `work.auto_done_set`, and the project is never offered again. */
export function recordAutoDoneSet(db: Database, projectId: string, autoDone: boolean, actor: string, at: number): void {
  recordEvent({ kind: 'work.auto_done_set', source: 'workSettings', actor, subject: `project:${projectId}`, trust: 'trusted', payload: { projectId, autoDone }, ts: at })
  markSeen(db, [projectId], actor, at)
}

/** One pass over projects not seen yet: offer for off, announce for on. Returns how many notices were new. */
export function announceAutoDone(db: Database, now: () => number = Date.now): number {
  const seen = seenSet(db)
  const fresh = allRows(db, 'SELECT id, name, work_auto_done FROM project ORDER BY created_at LIMIT ?', PROJECTS_MAX).filter((r) => !seen.has(String(r.id)))
  let added = 0
  for (const r of fresh) {
    const projectId = String(r.id)
    const name = String(r.name)
    const on = Number(r.work_auto_done) === 1
    const posted = on
      ? automaticAction({ db, now }, {
        name: 'auto_done_default', actor: 'system:work', subject: `project:${projectId}`, projectId,
        text: `Auto-done is on for ${name}: finished tasks whose check passes close themselves. Turn it off in the task board settings.`,
        undo: { label: 'Turn off', method: 'POST', path: WORK_SETTINGS_PATH, body: { projectId, autoDone: false } },
      })
      : automaticAction({ db, now }, {
        name: 'auto_done_offer', actor: 'system:work', subject: `project:${projectId}`, projectId,
        text: `Auto-done is available for ${name}: finished tasks whose check passes close themselves.`,
        undo: { label: 'Turn on', method: 'POST', path: WORK_SETTINGS_PATH, body: { projectId, autoDone: true } },
      })
    if (posted) added++
  }
  markSeen(db, fresh.map((r) => String(r.id)), 'system:work', now())
  return added
}
