// One-time boot backfill of `settings.setup` for installs that predate the first-run wizard: an
// install already in use (a workspace exists, or a Claude provider was saved) must not be greeted
// by the wizard after an upgrade. A brand-new install stays incomplete so the wizard shows.
// "One-time" = keyed on the raw stored document: once `setup` is stored (by this backfill, which
// always writes it, or by the wizard) the backfill never decides again, so a fresh install that
// later creates a workspace mid-wizard is not marked complete behind the user's back.
import type { SettingsPatch } from '../shared/settings.patch'
import { createLogger } from './logs'

const log = createLogger('settings')

export interface SetupBackfillDeps {
  /** Raw stored settings row (`Db.storedSettingsJson`). */
  storedJson: () => string | null
  save: (patch: SettingsPatch) => unknown
  /** Evidence the install was in use before the wizard existed. */
  existingInstall: () => boolean
  now?: () => number
}

/** True when the stored document already carries `setup` (a corrupt row counts as absent). */
function setupStored(json: string | null): boolean {
  if (!json) return false
  try {
    const doc: unknown = JSON.parse(json)
    return !!doc && typeof doc === 'object' && 'setup' in doc
  } catch {
    return false // corrupt row: settingsStore already warns and rewrites it from {}
  }
}

/** Runs the backfill; returns what it did ('skipped' = already decided before). */
export function backfillSetup(d: SetupBackfillDeps): 'completed' | 'fresh' | 'skipped' {
  if (setupStored(d.storedJson())) return 'skipped'
  const existing = d.existingInstall()
  d.save({ setup: { completedAt: existing ? (d.now ?? Date.now)() : null } })
  log.info('settings.setup.backfill', existing ? 'Existing install: first-run setup marked complete' : 'New install: first-run setup pending', { existing })
  return existing ? 'completed' : 'fresh'
}
