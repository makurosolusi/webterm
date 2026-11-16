// GET /api/browser/latency?sinceMs=: per-verb latency summary (count, okRate, p50, p95, max) from the in-memory
// ring buffer. Numbers only, no per-URL data. Behind the same /api gate as every other route; listed BEFORE the
// catch-all `browser` entry so the browser runtime never sees it. 503 while no recorder is active.
import { activeLatency } from '../browser/browserAgent.latency'
import { json, type ApiRoute } from './route.core'

/** Largest window a caller may ask for (the buffer is far shorter-lived than this anyway). */
export const LATENCY_SINCE_MAX_MS = 7 * 86_400_000

export const browserLatencyRoutes: ApiRoute[] = [
  {
    name: 'browser-latency',
    match: (c) => c.path === '/api/browser/latency' && c.method === 'GET',
    handle: (c) => {
      const raw = c.url.searchParams.get('sinceMs')
      const sinceMs = raw === null ? undefined : Number(raw)
      if (raw !== null && !(/^\d+$/.test(raw) && sinceMs! > 0 && sinceMs! <= LATENCY_SINCE_MAX_MS)) {
        json(c.res, 400, { error: 'invalid_sinceMs' })
        return true
      }
      const rec = activeLatency()
      if (!rec) json(c.res, 503, { error: 'latency_unavailable' })
      else json(c.res, 200, { verbs: rec.summary(sinceMs === undefined ? {} : { sinceMs }) })
      return true
    },
  },
]
