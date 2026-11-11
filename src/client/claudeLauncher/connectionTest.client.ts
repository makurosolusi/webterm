// Client side of the staged Test connection: POST /api/claude-provider/test streams NDJSON
// (server/claudeProvider/claudeProvider.connectionStream.ts), one event per line, the last carries `result`.
import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSettingsSaves } from '../useSettings'
import type { ClaudeInstall } from './claudeLaunch.client'

export type ConnStage = 'wrapper' | 'cli' | 'auth' | 'request'
export const CONN_STAGES: readonly ConnStage[] = ['wrapper', 'cli', 'auth', 'request']
export interface StageEvent {
  stage: ConnStage; state: 'running' | 'ok' | 'failed' | 'skipped' | 'pending'; detail?: string; hint?: string; ms?: number
  install?: ClaudeInstall; signIn?: { tool: string; hint: string; command?: string }
}
/** `ready`: run without the request (no tokens), every earlier stage passed. */
export interface FinalEvent { result: 'ok' | 'ready' | 'failed'; summary: string; stage?: ConnStage; failed?: string; ms: number; model?: string; via: string }

export const PROVIDER_TEST_PATH = '/api/claude-provider/test'

/** Runs (or joins) the server's test; `request: false` stops before the request stage (spends no tokens).
 *  `onStage` gets every stage line. Throws the error code, or AbortError on cancel. */
export async function streamConnectionTest(onStage: (e: StageEvent) => void, signal: AbortSignal, request = true): Promise<FinalEvent> {
  await flushSettingsSaves() // the server tests what is STORED
  const res = await fetch(PROVIDER_TEST_PATH, {
    method: 'POST', headers: { Accept: 'application/x-ndjson', 'Content-Type': 'application/json' }, cache: 'no-store', signal, body: JSON.stringify({ request }),
  })
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({})) as { error?: unknown } // non-JSON: the status is enough
    throw new Error(typeof data.error === 'string' ? data.error : `http_${res.status}`)
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (value) buf += dec.decode(value, { stream: true })
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const e = JSON.parse(buf.slice(0, i)) as StageEvent | FinalEvent
      buf = buf.slice(i + 1)
      if ('result' in e) return e
      onStage(e)
    }
    if (done) throw new Error('stream_ended')
  }
}

export interface ConnectionTestState {
  stages: Partial<Record<ConnStage, StageEvent>>
  final: FinalEvent | null
  running: boolean
  startedAt: number | null
  cancelled: boolean
  /** The test itself could not run (network, 403, cut stream): the error code. */
  error: string | null
}
/** `start({ request: false })`: the token-free check (wizard on open); `start()`: all four stages. */
export interface ConnectionTestHandle { state: ConnectionTestState; start(opts?: { request?: boolean }): Promise<FinalEvent | null>; cancel(): void }

const IDLE: ConnectionTestState = { stages: {}, final: null, running: false, startedAt: null, cancelled: false, error: null }

/** One Test connection: start (a second start while running returns the same run), live stages, cancel. */
export function useConnectionTest(): ConnectionTestHandle {
  const [state, setState] = useState<ConnectionTestState>(IDLE)
  const run = useRef<{ abort: AbortController; done: Promise<FinalEvent | null> } | null>(null)
  const live = useRef(true)
  useEffect(() => { live.current = true; return () => { live.current = false; run.current?.abort.abort() } }, [])
  const set = (f: (s: ConnectionTestState) => ConnectionTestState): void => { if (live.current) setState(f) }
  const start = useCallback((opts: { request?: boolean } = {}): Promise<FinalEvent | null> => {
    if (run.current) return run.current.done
    const abort = new AbortController()
    set(() => ({ ...IDLE, running: true, startedAt: Date.now() }))
    const done = streamConnectionTest((e) => set((s) => ({ ...s, stages: { ...s.stages, [e.stage]: e } })), abort.signal, opts.request !== false).then(
      (final) => { set((s) => ({ ...s, running: false, final })); return final },
      (e: unknown) => {
        const cancelled = abort.signal.aborted
        if (!cancelled) console.warn('claude provider: connection test failed', e instanceof Error ? e.message : 'error')
        set((s) => ({ ...s, running: false, cancelled, error: cancelled ? null : e instanceof Error ? e.message : 'error' }))
        return null
      },
    ).finally(() => { run.current = null })
    run.current = { abort, done }
    return done
  }, [])
  const cancel = useCallback((): void => { run.current?.abort.abort() }, [])
  return { state, start, cancel }
}
