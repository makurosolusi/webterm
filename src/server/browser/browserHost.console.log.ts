// Bridge from the page console (browserHost.console.ts) to the server log, channel `browser.page`, so an agent
// can read "why did this page fail" with `logs.summary` instead of asking for a screenshot of the console panel.
// Page text is untrusted and may hold tokens/PII, so only a narrow, scrubbed projection crosses: error/warning
// level, network failures and exceptions; URLs reduced to scheme://host/path; messages clipped; no stacks, no args.
// Repeats are counted, not logged: one line per failure group, re-emitted at count 5, 25, 125... with the running
// total and first/last time. Each node is capped at PAGE_LOG_RATE entries per second and PAGE_LOG_GROUPS groups.
import { createLogger, scrubText, stripUrlQuery } from '../logs'
import type { Logger } from '../logs'
import { classifyPageEntry, failureKey } from '../logs/logHints'
import type { PageFailure } from '../logs/logHints'
import type { EntryBody } from './browserHost.console.format'

export const PAGE_LOG_CHANNEL = 'browser.page'
export const PAGE_LOG_RATE = 20
export const PAGE_LOG_GROUPS = 100
export const PAGE_LOG_MESSAGE_MAX = 300
/** After an emit the next one for the same group waits for this many times more occurrences. */
const REEMIT_FACTOR = 5

const EVENT: Record<PageFailure['kind'], string> = {
  net: 'browser.page_net_error', console: 'browser.page_console_error', exception: 'browser.page_exception', security: 'browser.page_security',
}

interface Group { count: number; firstTs: number; lastTs: number; nextEmit: number }
interface NodeState { groups: Map<string, Group>; second: number; emitted: number; suppressed: number }

export interface PageLogSource { nodeId: string; workspaceId: string; profileId: string }
export interface PageLogBridge { record(src: PageLogSource, body: EntryBody): void }

export function createPageLogBridge(opts: { now?: () => number; logger?: Logger } = {}): PageLogBridge {
  const now = opts.now ?? Date.now
  const log = opts.logger ?? createLogger(PAGE_LOG_CHANNEL)
  const nodes = new Map<string, NodeState>()

  return {
    record(src, body) {
      const f = classifyPageEntry(body)
      if (!f) return
      const ts = now()
      let st = nodes.get(src.nodeId)
      if (!st) nodes.set(src.nodeId, (st = { groups: new Map(), second: 0, emitted: 0, suppressed: 0 }))
      const key = failureKey(f)
      let g = st.groups.get(key)
      if (!g) {
        if (st.groups.size >= PAGE_LOG_GROUPS) st.groups.delete(st.groups.keys().next().value as string) // oldest group
        st.groups.set(key, (g = { count: 0, firstTs: ts, lastTs: ts, nextEmit: 1 }))
      }
      g.count++
      g.lastTs = ts
      if (g.count < g.nextEmit) return
      const second = Math.floor(ts / 1000)
      if (second !== st.second) { st.second = second; st.emitted = 0 }
      if (st.emitted >= PAGE_LOG_RATE) { st.suppressed++; return } // group keeps counting and retries on its next occurrence
      st.emitted++
      g.nextEmit = g.count * REEMIT_FACTOR
      const suppressed = st.suppressed
      st.suppressed = 0
      const shown = f.host ? `${f.host}${f.path}` : f.path
      const text = f.kind === 'net' ? `${f.status ? `HTTP ${f.status}` : f.category} ${shown}`.trim() : scrubText(body.text, PAGE_LOG_MESSAGE_MAX)
      const emit = body.level === 'error' ? log.error : log.warn
      emit(EVENT[f.kind], scrubText(text, PAGE_LOG_MESSAGE_MAX), {
        ids: { nodeId: src.nodeId, workspaceId: src.workspaceId, profileId: src.profileId },
        kind: f.kind, category: f.category, host: f.host, ...(f.status ? { status: f.status } : {}), path: f.path, sig: f.sig,
        ...(f.kind !== 'net' && body.url ? { url: stripUrlQuery(body.url) } : {}),
        count: g.count, firstTs: g.firstTs, lastTs: g.lastTs, ...(suppressed ? { suppressed } : {}),
      })
    },
  }
}
