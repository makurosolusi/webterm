// Satu-satunya pembentuk entri log cookie (Rule 7/12): hanya {workspaceId, domains, count, action}.
// Field dipilih eksplisit, jadi nilai/nama cookie tak bisa lolos walau objek masukan memuatnya.
import { domainKey } from './cookieImport.parse'

export type CookieAction = 'preview' | 'commit' | 'save' | 'load' | 'clear' | 'list' | 'sweep'
export interface CookieLogEntry { workspaceId: string; domains: string[]; count: number; action: CookieAction }

const LOG_DOMAINS_MAX = 20

/** Bentuk entri log aman dari cookie (hanya `domain` yang dibaca). */
export function cookieLogEntry(action: CookieAction, workspaceId: string, cookies: ReadonlyArray<{ domain: string }>): CookieLogEntry {
  const domains = [...new Set(cookies.map((c) => domainKey(c.domain)))].sort().slice(0, LOG_DOMAINS_MAX)
  return { workspaceId, domains, count: cookies.length, action }
}
