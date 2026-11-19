// Thin client for /api/custom-commands (contract: src/shared/customCommands.ts, server: customCommands.api.ts).
// The UI's credential is its HttpOnly cookie, so a plain same-origin fetch is a logged-in call.
import { CUSTOM_COMMANDS_PATH, type CustomCommandDetected } from '../../shared/customCommands'

export interface ExtraDir { dir: string; exists: boolean; safe: boolean }
export interface SessionDir { name: string; dir: string }
export interface CommandPaths { managed: string; platformDir: string; extra: ExtraDir[]; common: string[]; session: SessionDir[] }

/** Server error: HTTP status, stable code and the server's own sentence (it never carries secrets). */
export class CommandsApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'CommandsApiError'
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

async function call<T>(suffix: string, method = 'GET', body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(CUSTOM_COMMANDS_PATH + suffix, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  let parsed: unknown
  try { parsed = await res.json() } catch { parsed = undefined } // not JSON: the status alone is the answer
  if (!res.ok) {
    const code = isObj(parsed) && typeof parsed.error === 'string' ? parsed.error : `http_${res.status}`
    const message = isObj(parsed) && typeof parsed.message === 'string' ? parsed.message : `Request failed (${res.status}).`
    throw new CommandsApiError(res.status, code, message)
  }
  return parsed as T
}

const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])

/** Every executable webterm found (managed dir, tool folders, PATH, known wrappers); nothing is run. */
export async function fetchDetected(): Promise<CustomCommandDetected[]> {
  const r = await call<{ candidates?: unknown }>('/detect')
  return list<CustomCommandDetected>(r.candidates)
}

export async function fetchPaths(): Promise<CommandPaths> {
  const r = await call<Partial<Record<keyof CommandPaths, unknown>>>('/paths')
  return {
    managed: typeof r.managed === 'string' ? r.managed : '',
    platformDir: typeof r.platformDir === 'string' ? r.platformDir : '',
    extra: list<ExtraDir>(r.extra),
    common: list<unknown>(r.common).filter((d): d is string => typeof d === 'string'),
    session: list<SessionDir>(r.session),
  }
}

export const addToolFolder = (dir: string): Promise<unknown> => call('/paths', 'POST', { dir })
export const removeToolFolder = (dir: string): Promise<unknown> => call('/paths/remove', 'POST', { dir })

/** Re-scan the usual tool folders and the login shell now; resolves how many folders were added to PATH. */
export async function rescanCommands(): Promise<number> {
  const r = await call<{ added?: unknown }>('/rescan', 'POST', {})
  return typeof r.added === 'number' ? r.added : 0
}
