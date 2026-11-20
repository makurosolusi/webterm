// Loopback credential proxy: swaps the placeholder token for the real upstream credential and streams the reply.
// Design and threat table: docs/decisions/credential-proxy.md section 4.
import { randomUUID } from 'node:crypto'
import { createLogger } from '../logs'
import { buildUpstreamHeaders, filterResponseHeaders, presentedToken, tokensEqual } from './credentialProxy.headers'
import { rawTarget, resolveTarget } from './credentialProxy.upstream'
import type { ProxyErrorCode, Upstream } from './credentialProxy.types'

const log = createLogger('credential-proxy')

// The project tsc has no Bun types (see fsSearch.ts); only the slice used here.
export interface ProxyServer { readonly port: number; stop(force?: boolean): Promise<void> }
declare const Bun: { serve(opts: { hostname: string; port: number; idleTimeout: number; maxRequestBodySize: number; fetch: (req: Request) => Promise<Response> }): ProxyServer }

export const MAX_BODY_BYTES = 32 * 1024 * 1024
export const MAX_IN_FLIGHT = 64
export const TTFB_TIMEOUT_MS = 120_000
export const IDLE_CHUNK_TIMEOUT_MS = 300_000
const METHODS = new Set(['GET', 'POST', 'DELETE', 'HEAD'])
const HTTP_BAD_REQUEST = 400
const HTTP_UNAUTHORIZED = 401
const HTTP_METHOD_NOT_ALLOWED = 405
const HTTP_TOO_LARGE = 413
const HTTP_TOO_MANY = 429
const HTTP_BAD_GATEWAY = 502
const HTTP_GATEWAY_TIMEOUT = 504

export interface ProxyDeps {
  /** The placeholder token every client must present. */
  token: string
  /** Current real upstream, read per request (live reconfiguration), or null when none is configured. */
  resolveUpstream: () => Upstream | null
  fetchImpl?: typeof fetch
  maxBodyBytes?: number
  maxInFlight?: number
  ttfbTimeoutMs?: number
  idleChunkTimeoutMs?: number
}

const STATUS: Record<ProxyErrorCode, number> = {
  bad_proxy_token: HTTP_UNAUTHORIZED, no_upstream: 503, upstream_unreachable: HTTP_BAD_GATEWAY, upstream_timeout: HTTP_GATEWAY_TIMEOUT,
  proxy_busy: HTTP_TOO_MANY, body_too_large: HTTP_TOO_LARGE, bad_request: HTTP_BAD_REQUEST,
}

/** Anthropic-shaped error body; the message is a static code, never upstream or request content. */
export function proxyError(code: ProxyErrorCode, status: number = STATUS[code]): Response {
  const body = { type: 'error', error: { type: 'api_error', message: `webterm credential proxy: ${code}` } }
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

class BodyTooLarge extends Error {}

/** Whole request body, rejected as soon as it exceeds `cap` (Content-Length is only a fast path). */
async function readCapped(req: Request, cap: number): Promise<Blob | null> {
  const declared = Number(req.headers.get('content-length') ?? 0)
  if (declared > cap) throw new BodyTooLarge()
  if (!req.body) return null
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = req.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > cap) { await reader.cancel().catch(() => undefined); throw new BodyTooLarge() }
    chunks.push(value)
  }
  return new Blob(chunks as BlobPart[])
}

/** Pass the upstream body through, erroring if no chunk arrives within `idleMs`; closing the client aborts upstream. */
function relayBody(upstream: ReadableStream<Uint8Array>, idleMs: number, abort: () => void, finish: (bytes: number) => void): ReadableStream<Uint8Array> {
  const reader = upstream.getReader()
  let finished = false
  const onDone = (n: number): void => { if (!finished) { finished = true; finish(n) } }
  let bytes = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const idle = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('idle')), idleMs) })
      try {
        const { done, value } = await Promise.race([reader.read(), idle])
        clearTimeout(timer)
        if (done) { controller.close(); onDone(bytes); return }
        bytes += value.byteLength
        controller.enqueue(value)
      } catch (err) {
        clearTimeout(timer)
        abort()
        onDone(bytes)
        controller.error(err instanceof Error ? err : new Error('upstream stream failed'))
      }
    },
    cancel() { clearTimeout(timer); abort(); onDone(bytes); return reader.cancel().catch(() => undefined) },
  })
}

/** Build the request handler; one instance owns the in-flight counter. */
export function createProxyHandler(deps: ProxyDeps): (req: Request) => Promise<Response> {
  const doFetch = deps.fetchImpl ?? fetch
  const maxBody = deps.maxBodyBytes ?? MAX_BODY_BYTES
  const maxInFlight = deps.maxInFlight ?? MAX_IN_FLIGHT
  const ttfbMs = deps.ttfbTimeoutMs ?? TTFB_TIMEOUT_MS
  const idleMs = deps.idleChunkTimeoutMs ?? IDLE_CHUNK_TIMEOUT_MS
  let inFlight = 0

  async function forward(req: Request, target: string, id: string, started: number, slot: { streaming: boolean; free: () => void }): Promise<Response> {
    const t = resolveTarget(deps.resolveUpstream, target)
    if (!t.ok) return proxyError(t.code, t.status)
    let body: Blob | null = null
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      try { body = await readCapped(req, maxBody) } catch (err) {
        if (err instanceof BodyTooLarge) return proxyError('body_too_large')
        return proxyError('bad_request')
      }
    }
    const ctl = new AbortController()
    let timedOut = false
    const onClientAbort = (): void => ctl.abort()
    req.signal.addEventListener('abort', onClientAbort, { once: true })
    const ttfb = setTimeout(() => { timedOut = true; ctl.abort() }, ttfbMs)
    const path = target.split('?')[0]!
    let res: Response
    try {
      res = await doFetch(t.url, { method: req.method, headers: buildUpstreamHeaders(req.headers, t.upstream), body, signal: ctl.signal, redirect: 'manual' })
    } catch {
      clearTimeout(ttfb)
      req.signal.removeEventListener('abort', onClientAbort)
      const code: ProxyErrorCode = timedOut ? 'upstream_timeout' : 'upstream_unreachable'
      log.warn('credential_proxy.upstream_failed', 'Credential proxy could not complete the upstream request', { id, method: req.method, path, code, ms: Date.now() - started })
      return proxyError(code)
    }
    clearTimeout(ttfb)
    const headers = filterResponseHeaders(res.headers)
    if (!res.body) {
      req.signal.removeEventListener('abort', onClientAbort)
      log.debug('credential_proxy.request', 'Credential proxy request', { id, method: req.method, path, status: res.status, ms: Date.now() - started, bytes: 0 })
      return new Response(null, { status: res.status, headers })
    }
    slot.streaming = true
    const stream = relayBody(res.body, idleMs, () => ctl.abort(), (bytes) => {
      slot.free()
      req.signal.removeEventListener('abort', onClientAbort)
      log.debug('credential_proxy.request', 'Credential proxy request', { id, method: req.method, path, status: res.status, ms: Date.now() - started, bytes })
    })
    return new Response(stream, { status: res.status, headers })
  }

  return async (req) => {
    if (!tokensEqual(presentedToken(req.headers), deps.token)) return proxyError('bad_proxy_token')
    if (!METHODS.has(req.method)) return proxyError('bad_request', HTTP_METHOD_NOT_ALLOWED)
    const target = rawTarget(req.url)
    if (inFlight >= maxInFlight) return proxyError('proxy_busy')
    inFlight++
    let freed = false
    const slot = { streaming: false, free: () => { if (!freed) { freed = true; inFlight-- } } }
    try {
      return await forward(req, target, randomUUID().slice(0, 8), Date.now(), slot)
    } finally {
      // A streamed body keeps its slot until it ends; any other answer frees it now.
      if (!slot.streaming) slot.free()
    }
  }
}

/** Bind the handler on loopback only. Port 0 lets the OS choose. */
export function serveProxy(handler: (req: Request) => Promise<Response>, port: number, maxBodyBytes: number = MAX_BODY_BYTES): ProxyServer {
  // idleTimeout 0 = never cut a silent SSE stream (verified by the 5 s silent-stream test).
  return Bun.serve({ hostname: '127.0.0.1', port, idleTimeout: 0, maxRequestBodySize: maxBodyBytes + 1024 * 1024, fetch: handler })
}
