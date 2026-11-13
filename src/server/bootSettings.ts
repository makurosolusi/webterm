// Settings that boot writes on its own, split from server.main.ts (which starts the server on import).
// Each step is queued in bootChanges.ts and announced once the ledger is up; a failing step is logged
// and never stops boot. server.main.ts calls them at fixed points of its boot order.
import type { Logger } from './logs'
import type { EnvSettings } from './envSettings.service'
import { db } from './db'
import { queueBootChange } from './bootChanges'
import { syncLinkedSettings } from './featureCapabilities.service'
import { backfillSetup } from './setupBackfill'
import { loadConfig, providerSaved } from './claudeProvider/claudeProvider.store'
import { defaultProfileAfter } from './claudeProvider/claudeProvider.command'

type BootLog = Pick<Logger, 'info' | 'warn'>

const cause = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Worker/Autonomy cards already on before their derived values exist: fill them now, without a re-toggle
 * (zero-config). Runs right after the env overlay, before the ledger and channels read env.
 */
export function applyLinkedSettings(envSettings: EnvSettings, log: BootLog): void {
  // Gagal (mis. Pengaturan dikunci) tidak menghentikan boot: kartu tetap bisa dimatikan-nyalakan.
  try {
    queueBootChange('default_on', envSettings.defaultsApplied())
    const linked = syncLinkedSettings(envSettings, process.env)
    queueBootChange('linked', linked)
    if (linked.length > 0) log.info('capabilities.linked_synced', 'Applied card-linked settings for capabilities already on', { keys: linked })
  } catch (err) {
    log.warn('capabilities.linked_sync_failed', 'Cannot apply card-linked settings at boot', { error: cause(err) })
  }
}

/** One-time upgrades of stored settings: first-run setup backfill, then the default Claude profile. */
export function migrateStoredSettings(log: BootLog): void {
  // Upgrade path for the first-run wizard: an install already in use is marked set up (once, see setupBackfill.ts).
  try {
    if (backfillSetup({ storedJson: () => db.storedSettingsJson(), save: (p) => db.saveSettings(p), existingInstall: () => db.listSummaries(1).items.length > 0 || providerSaved() }) === 'completed') queueBootChange('setup', ['setup'])
  } catch (e) {
    log.warn('settings.setup.backfill_failed', 'Cannot backfill first-run setup state at boot', { cause: cause(e) })
  }
  // Command mode's profile is the default for new agents (saved together since the Claude page); an older
  // install that saved command mode alone gets the default written once (idempotent: equal = no write).
  try {
    const id = defaultProfileAfter({ mode: 'login' }, loadConfig(), db.getSettings().defaultClaudeProfileId)
    if (id !== null) { db.saveSettings({ defaultClaudeProfileId: id }); queueBootChange('profile', ['defaultClaudeProfileId']) }
  } catch (e) {
    log.warn('settings.claude_default.migrate_failed', 'Cannot align the default Claude profile with command mode at boot', { cause: cause(e) })
  }
}
