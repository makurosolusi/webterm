// One-time boot migrations for the 2026-11-17 owner decision (docs/decisions/central-autonomy-default.md): Central is
// free except for writing code, so the old default 'propose' moves up to the new default. A marker row in `app` makes
// each step final: it never decides twice, and a later explicit choice by the owner is never overwritten.
import type { Database } from 'bun:sqlite'
import { appendEvent } from './ledger/ledgerEvent'
import { execWrite } from './ledger/ledgerCore'
import { CONTROL_AUDIT_KIND, DEFAULT_GLOBAL_LEVEL, projectRef, readLevel } from './central/guard/levelStore'

export const AUTONOMY_ENV_MARKER = 'central_autonomy_env_v1'
export const AUTONOMY_LEVEL_MARKER = 'central_autonomy_level_v1'
const MIGRATION_ACTOR = 'system:migration'
/** Only a server-written row (`system:*`) can be a default; any other actor id is the owner (UI/API token ids vary), so its level is a choice. */
const SERVER_ACTOR = /^system/

export interface AutonomyEnvDeps {
  getFlag: (key: string) => string | null
  setFlag: (key: string, value: string) => void
  /** Stored override of `WEBTERM_CENTRAL_AGENTS` (value + whether it came from Settings), or null when none. */
  stored: () => { value: string; source: 'override' | 'env' | 'default' } | null
  save: (value: 'auto') => unknown
}

/**
 * The old card sync wrote `propose` into Settings for every install with the Worker card on, so a stored `propose`
 * is the old default (Settings offers no other way to pick it). It moves to `auto` once; shell/.env values are left alone.
 */
export function migrateAgentsEnvDefault(d: AutonomyEnvDeps): 'moved' | 'marked' | 'skipped' {
  if (d.getFlag(AUTONOMY_ENV_MARKER) !== null) return 'skipped'
  const s = d.stored()
  const moved = s !== null && s.source === 'override' && s.value === 'propose'
  if (moved) d.save('auto') // Save first: a failure leaves the marker unset, so the next boot retries.
  d.setFlag(AUTONOMY_ENV_MARKER, moved ? 'moved' : 'marked')
  return moved ? 'moved' : 'marked'
}

export interface AutonomyLevelDeps {
  db: Database
  now: () => number
  getFlag: (key: string) => string | null
  setFlag: (key: string, value: string) => void
}

/**
 * A global `propose` row with no reason from the owner (written by the server, no note) is the old default
 * and rises to the new default once, with an audit event. Rows with a reason or an owner actor id stay; so do per-project rows.
 */
export function migrateGlobalLevelDefault(d: AutonomyLevelDeps): 'moved' | 'marked' | 'skipped' {
  if (d.getFlag(AUTONOMY_LEVEL_MARKER) !== null) return 'skipped'
  const row = readLevel(d.db, 'global')
  const moved = row !== null && row.level === 'propose' && !row.reason && SERVER_ACTOR.test(row.setBy)
  if (moved && row) {
    const at = d.now()
    execWrite(d.db, 'UPDATE central_control SET level = ?, set_by = ?, set_at = ?, version = ? WHERE scope = ?', DEFAULT_GLOBAL_LEVEL, MIGRATION_ACTOR, at, row.version + 1, 'global')
    appendEvent({ db: d.db, now: d.now }, { actor: MIGRATION_ACTOR, kind: CONTROL_AUDIT_KIND, ...projectRef(d.db, null), payload: { scope: 'global', from: 'propose', to: DEFAULT_GLOBAL_LEVEL, reason: 'central autonomy default', actorKind: 'system', version: row.version + 1 } })
  }
  d.setFlag(AUTONOMY_LEVEL_MARKER, moved ? 'moved' : 'marked')
  return moved ? 'moved' : 'marked'
}
