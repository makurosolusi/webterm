// Live feed for the Activity timeline: newest history page, then SSE from the last seen seq.
// Resume follows the server contract (`?afterSeq=<n>`, events/eventsApi.ts): on any stream error
// the source is closed and reopened after a backoff with the highest seq received, so nothing is
// replayed twice and nothing is missed. Same reconnect shape as output/logStreamStore.ts.
import { useCallback, useEffect, useRef, useState } from 'react'
import { mergeEvents, type TimelineEvent } from './Timeline.model'
import { getJson } from './Timeline.status'
import { afterPageLoad } from './pageLoad'

export const STREAM_URL = '/api/events/stream'
export const HISTORY_URL = '/api/events/history'
export const PAGE_SIZE = 100
/** Client-side cap; the oldest rows drop off (they stay reachable via "Load older"). */
export const CLIENT_CAP = 5000
const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 30_000

export type Connection = 'connecting' | 'open' | 'closed'

export interface TimelineFeed {
  events: TimelineEvent[]
  more: boolean
  loadingOlder: boolean
  connection: Connection
  error: string | null
  loadOlder: () => Promise<void>
  /** Bumped on every (re)connect, so status surfaces can refresh with the stream. */
  epoch: number
}

interface HistoryPage { events: TimelineEvent[]; more: boolean }

function asPage(body: unknown): HistoryPage {
  const b = body as Partial<HistoryPage> | null
  if (!b || !Array.isArray(b.events)) throw new Error('GET /api/events/history: malformed response')
  return { events: b.events, more: b.more === true }
}

const historyUrl = (beforeSeq?: number): string =>
  `${HISTORY_URL}?limit=${PAGE_SIZE}${beforeSeq === undefined ? '' : `&beforeSeq=${beforeSeq}`}`

/** Subscribes while `enabled`; closes the stream and timers when disabled or unmounted. */
export function useTimelineFeed(enabled: boolean): TimelineFeed {
  const [events, setEvents] = useState<TimelineEvent[]>([])
  const [more, setMore] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [connection, setConnection] = useState<Connection>('closed')
  const [error, setError] = useState<string | null>(null)
  const [epoch, setEpoch] = useState(0)
  const eventsRef = useRef<TimelineEvent[]>([])
  eventsRef.current = events

  useEffect(() => {
    if (!enabled) return
    let stopped = false
    let source: EventSource | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let attempts = 0
    let lastSeq = 0
    let loaded = false

    const ingest = (incoming: TimelineEvent[]): void => {
      for (const e of incoming) if (e.seq > lastSeq) lastSeq = e.seq
      setEvents((cur) => mergeEvents(cur, incoming, CLIENT_CAP))
    }
    const retry = (): void => {
      if (stopped) return
      source?.close()
      source = null
      setConnection('closed')
      timer = setTimeout(connect, Math.min(RETRY_BASE_MS * 2 ** attempts, RETRY_MAX_MS))
      attempts += 1
    }
    async function connect(): Promise<void> {
      timer = null
      setConnection('connecting')
      try {
        if (!loaded) {
          const page = asPage(await getJson(historyUrl()))
          if (stopped) return
          loaded = true
          setMore(page.more)
          ingest(page.events)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        retry()
        return
      }
      const next = new EventSource(`${STREAM_URL}?afterSeq=${lastSeq}`)
      source = next
      next.onopen = () => { if (stopped) return; attempts = 0; setError(null); setConnection('open'); setEpoch((n) => n + 1) }
      next.addEventListener('sense', (msg) => {
        if (stopped) return
        try {
          ingest([JSON.parse((msg as MessageEvent<string>).data) as TimelineEvent])
        } catch {
          // A malformed frame is skipped; the next reconnect resumes from lastSeq and re-syncs.
        }
      })
      next.onerror = retry
    }
    const cancelStart = afterPageLoad(() => void connect())
    return () => {
      stopped = true
      cancelStart()
      if (timer) clearTimeout(timer)
      source?.close()
    }
  }, [enabled])

  const loadOlder = useCallback(async () => {
    const oldest = eventsRef.current.find((e) => e.seq > 0)
    if (!oldest) return
    setLoadingOlder(true)
    try {
      const page = asPage(await getJson(historyUrl(oldest.seq)))
      setMore(page.more)
      // Older rows go below the cap check's cut-off, so merge without dropping them.
      setEvents((cur) => mergeEvents(cur, page.events, Number.MAX_SAFE_INTEGER))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingOlder(false)
    }
  }, [])

  return { events, more, loadingOlder, connection, error, loadOlder, epoch }
}
