// Check-in settings and reminders for the board and Settings. Like the task board these are not node-token paths
// (auth.ts `isNodeTokenPath`); writes need a `human:*` actor. Lock: routes/route.uiOnly.policy.bun.test.ts.
import { CHECKIN_DAILY_LIMITS, type CheckinSettings } from '../../shared/centralWork'
import type { RouteResult } from '../apiShared.types'
import type { Ca2Handle } from './ca2Boot'
import { HUMAN_PREFIX } from './ca2Routes.act'
import { pageOf } from './ca2Routes.read'
import { systemTurnsToday } from './chat/turnService'
import { productionCheckinSettings, type CheckinSettingsPort } from './work/workCheckin'
import { cancelReminder, listReminders } from './work/workReminders'

const SETTINGS = '/api/central/checkin-settings'
const REMINDERS = '/api/central/reminders'
const CANCEL = /^\/api\/central\/reminders\/([^/]+)\/cancel$/

type Body = Record<string, unknown>
const fail = (status: number, error: string): RouteResult => ({ status, body: { error } })
const notAllowed = fail(405, 'method_not_allowed')
const bodyOf = (raw: unknown): Body => (raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Body) : {})
const decode = (s: string): string | null => { try { return decodeURIComponent(s) } catch { return null } }

/** Whether `path` is a check-in or reminder route. */
export const isCheckinPath = (path: string): boolean => path === SETTINGS || path === REMINDERS || CANCEL.test(path)

async function view(h: Ca2Handle, settings: CheckinSettingsPort): Promise<RouteResult> {
  const body: CheckinSettings = { ...await settings.read(), usedToday: systemTurnsToday(h.db, h.now()) }
  return { status: 200, body }
}

async function write(h: Ca2Handle, { enabled, dailyLimit }: Body, settings: CheckinSettingsPort): Promise<RouteResult> {
  if (enabled !== undefined && typeof enabled !== 'boolean') return fail(400, 'invalid_enabled')
  if (dailyLimit !== undefined && !(CHECKIN_DAILY_LIMITS as readonly unknown[]).includes(dailyLimit)) return fail(400, 'invalid_daily_limit')
  await settings.write({ ...(enabled !== undefined ? { enabled } : {}), ...(dailyLimit !== undefined ? { dailyLimit: dailyLimit as number } : {}) })
  return view(h, settings)
}

function cancel(h: Ca2Handle, rawId: string): RouteResult {
  const id = decode(rawId)
  if (id === null) return fail(400, 'invalid_id')
  const result = cancelReminder(h.db, id)
  if (result === 'not_found') return fail(404, 'reminder_not_found')
  return result === 'not_pending' ? fail(409, 'reminder_not_pending') : { status: 200, body: { id, status: 'cancelled' } }
}

/** Answers a path `isCheckinPath` accepted. */
export async function checkinDispatch(
  h: Ca2Handle, req: { method: string; path: string; query: URLSearchParams; body: () => Promise<unknown> }, actor: string, settings: CheckinSettingsPort = productionCheckinSettings,
): Promise<RouteResult> {
  const { method, path, query } = req
  if (method === 'POST' && !actor.startsWith(HUMAN_PREFIX)) return fail(403, 'human_only')
  if (path === SETTINGS) {
    if (method === 'GET') return view(h, settings)
    return method === 'POST' ? write(h, bodyOf(await req.body()), settings) : notAllowed
  }
  if (path === REMINDERS) {
    if (method !== 'GET') return notAllowed
    const page = pageOf(query)
    return page ? { status: 200, body: listReminders(h.db, page) } : fail(400, 'invalid_page')
  }
  return method === 'POST' ? cancel(h, CANCEL.exec(path)?.[1] ?? '') : notAllowed
}
