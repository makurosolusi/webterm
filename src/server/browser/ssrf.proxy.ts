// Proxy penyaring SSRF (c §6.1): Chromium dipaksa lewat sini. Resolve DNS SENDIRI, validasi SEMUA IP hasil,
// lalu sambung ke IP yang sudah divalidasi (bukan resolve ulang) -> menutup DNS-rebinding. Bind 127.0.0.1,
// hanya `CONNECT host:port` dan request berbentuk absolut; tanpa kredensial; log hanya hostname.
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { connect, isIP, type Socket } from 'node:net'
import { lookup } from 'node:dns/promises'
import { type BlockReason } from '../../shared/browser.contract'
import { createLogger } from '../logs'
import { isAllowed, isLocalName, normalizeHost, type AllowSet } from './ssrf.allowlist'
import { allowNow } from './navigation.guard'
import { classifyIp, isLoopbackOrUnspecified } from './ssrf.ip'

/** Resolver DNS yang bisa diinjeksi: nama host -> daftar IP. */
export type Resolver = (host: string) => Promise<string[]>
/** Pembuka koneksi ke IP tervalidasi (diinjeksi test). */
export type Dial = (ip: string, port: number) => Socket

export interface SsrfProxyOptions {
  /** Allowlist host:port; fungsi = dibaca ulang tiap koneksi (tanpa restart). */
  allow: AllowSet | (() => AllowSet)
  /** Webterm bind loopback: nama lokal yang SEMUA IP-nya loopback boleh (port webterm tetap ditolak). */
  allowLoopback?: boolean
  /** Port webterm sendiri: tak pernah boleh dituju pada loopback walau ada di allowlist. */
  webtermPort: number
  port?: number
  resolver?: Resolver
  dial?: Dial
  /** Every refusal (host normalized); the runtime turns it into node state, since Chromium only sees a 403. */
  onDeny?: (hostname: string, reason: BlockReason) => void
}
export interface SsrfProxy { port: number; close(): Promise<void> }

const BIND_HOST = '127.0.0.1'
const PORT_MAX = 65_535
const CONNECT_TIMEOUT_MS = 15_000
const STRIPPED_HEADERS = ['proxy-connection', 'proxy-authorization']
const log = createLogger('browser.ssrf')

/** Resolver bawaan: `getaddrinfo` (hormati /etc/hosts), IPv4 lebih dulu. */
export const systemResolver: Resolver = async (host) => {
  const all = await lookup(host, { all: true, verbatim: true })
  return all.sort((a, b) => a.family - b.family).map((a) => a.address)
}
const systemDial: Dial = (ip, port) => connect({ host: ip, port })

type Decision = { ok: true; ip: string } | { ok: false; reason: BlockReason }

async function decide(rawHost: string, port: number, o: Required<Pick<SsrfProxyOptions, 'allow' | 'webtermPort' | 'resolver' | 'allowLoopback'>>): Promise<Decision> {
  const host = normalizeHost(rawHost)
  if (!host || !Number.isInteger(port) || port < 1 || port > PORT_MAX) return { ok: false, reason: 'not_allowed_port' }
  let ips: string[]
  try {
    ips = isIP(host) ? [host] : await o.resolver(host)
  } catch (err) {
    log.warn('browser.ssrf.dns_fail', 'dns resolve failed', { hostname: host, cause: err instanceof Error ? err.name : 'unknown' })
    return { ok: false, reason: 'dns_fail' }
  }
  if (ips.length === 0) return { ok: false, reason: 'dns_fail' }
  // ponytail: hard-deny memakai loopback saja; webterm yang bind ke IP LAN + allowlist IP itu belum tertangkap (tambah cek os.networkInterfaces bila perlu)
  if (port === o.webtermPort && ips.some(isLoopbackOrUnspecified)) return { ok: false, reason: 'not_allowed_port' }
  // Hanya NAMA lokal (localhost, *.localhost, IP loopback literal): nama publik yang resolve ke 127.0.0.1 tetap
  // ditolak, kalau tidak halaman asing bisa DNS-rebinding ke dev server lokal.
  if (o.allowLoopback && isLocalName(host) && ips.every(isLoopbackOrUnspecified)) return { ok: true, ip: ips[0] }
  if (!isAllowed(allowNow(o.allow), host, port) && ips.some((ip) => classifyIp(ip) === 'private')) return { ok: false, reason: 'private_host' }
  return { ok: true, ip: ips[0] }
}

/** Mulai proxy di 127.0.0.1 (port acak bila `port` kosong). */
export async function startSsrfProxy(opts: SsrfProxyOptions): Promise<SsrfProxy> {
  const o = { allow: opts.allow, webtermPort: opts.webtermPort, allowLoopback: opts.allowLoopback ?? false, resolver: opts.resolver ?? systemResolver }
  const dial = opts.dial ?? systemDial
  const deny = (hostname: string, reason: BlockReason): void => {
    log.warn('browser.ssrf.block', 'blocked outbound connection', { hostname, reason })
    opts.onDeny?.(hostname, reason)
  }
  const sockets = new Set<Socket>()

  const server: Server = createServer()
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })

  server.on('connect', async (req: IncomingMessage, client: Socket, head: Buffer) => {
    client.on('error', () => client.destroy()) // klien putus: tak ada yang bisa dilaporkan
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url ?? '')
    const host = m?.[1] ?? ''
    const d = m ? await decide(host, Number(m[2]), o) : ({ ok: false, reason: 'not_allowed_port' } as const)
    if (!d.ok) {
      deny(normalizeHost(host), d.reason)
      client.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nblocked: ${d.reason}\r\n`)
      return
    }
    const upstream = dial(d.ip, Number(m?.[2]))
    upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy(new Error('upstream connect timeout')))
    let established = false
    upstream.once('connect', () => {
      established = true
      upstream.setTimeout(0)
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.on('error', (err) => {
      log.warn('browser.ssrf.upstream_error', 'upstream connection failed', { hostname: normalizeHost(host), cause: err.name })
      if (established) client.destroy()
      else client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
    })
    upstream.on('close', () => { if (established) client.destroy() })
    client.on('close', () => upstream.destroy())
  })

  server.on('request', async (req: IncomingMessage, res: ServerResponse) => {
    const fail = (status: number, text: string): void => { res.writeHead(status, { 'Content-Type': 'text/plain', Connection: 'close' }); res.end(text) }
    let target: URL
    try {
      target = new URL(req.url ?? '')
    } catch {
      return fail(400, 'bad request: absolute URL required') // origin-form = bukan proxy request -> tolak
    }
    if (target.protocol !== 'http:') return fail(400, 'bad request: http only')
    const port = target.port ? Number(target.port) : 80
    const d = await decide(target.hostname, port, o)
    if (!d.ok) {
      deny(normalizeHost(target.hostname), d.reason)
      return fail(403, `blocked: ${d.reason}`)
    }
    const headers = { ...req.headers }
    for (const h of STRIPPED_HEADERS) delete headers[h]
    const up = httpRequest({
      method: req.method, path: target.pathname + target.search, headers, setHost: false,
      createConnection: () => dial(d.ip, port),
    }, (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers)
      ur.pipe(res)
    })
    up.on('error', (err) => {
      log.warn('browser.ssrf.upstream_error', 'upstream request failed', { hostname: normalizeHost(target.hostname), cause: err.name })
      if (res.headersSent) res.destroy()
      else fail(502, 'bad gateway')
    })
    req.pipe(up)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', (err) => reject(new Error(`ssrf proxy failed to listen on ${BIND_HOST}: ${err.message}`)))
    server.listen(opts.port ?? 0, BIND_HOST, resolve)
  })
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()) }),
  }
}
