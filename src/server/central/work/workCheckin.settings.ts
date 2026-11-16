// The two Settings > Central Agent check-in switches, behind a port so tests inject a fake.
import { CHECKIN_DAILY_LIMITS, DEFAULT_CHECKIN_DAILY_LIMIT, type CheckinSettings } from '../../../shared/centralWork'

type Enabled = Omit<CheckinSettings, 'usedToday'>

/** The two user settings, read on every tick so a change applies live. */
export interface CheckinSettingsPort {
  read(): Promise<Enabled>
  write(patch: Partial<Enabled>): Promise<void>
}

/** Settings > Central Agent, stored in the shared settings row; `db` opens webterm.db, so it loads on first use. */
export const productionCheckinSettings: CheckinSettingsPort = {
  async read() {
    const s = (await import('../../db')).db.getSettings()
    return { enabled: s.centralCheckins, dailyLimit: (CHECKIN_DAILY_LIMITS as readonly number[]).includes(s.centralCheckinDailyLimit) ? s.centralCheckinDailyLimit : DEFAULT_CHECKIN_DAILY_LIMIT }
  },
  async write({ enabled, dailyLimit }) {
    (await import('../../db')).db.saveSettings({ ...(enabled !== undefined ? { centralCheckins: enabled } : {}), ...(dailyLimit !== undefined ? { centralCheckinDailyLimit: dailyLimit } : {}) })
  },
}
