// Bun-only: proxy SSRF nyata di 127.0.0.1 melawan server tujuan lokal. DNS dan dial diinjeksi
// (resolver palsu: rebinding; dial dialihkan ke server lokal sambil mencatat IP yang dituju).
import { afterAll, expect, test } from 'bun:test'
import { createServer as createHttp } from 'node:http'
import { connect, createServer as createTcp, type AddressInfo } from 'node:net'
import { allowKey } from './ssrf.allowlist'
import { startSsrfProxy, type Resolver } from './ssrf.proxy'

const PUBLIC_IP = '93.184.216.34'
const SELF_PORT = 48_700
const echo = createTcp((s) => s.pipe(s))
const web = createHttp((req, res) => res.end(`hello ${req.headers.host}`))
await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r))
await new Promise<void>((r) => web.listen(0, '127.0.0.1', r))
const echoPort = (echo.address() as AddressInfo).port
const webPort = (web.address() as AddressInfo).port
const closers: Array<() => Promise<void>> = []
afterAll(async () => {
  for (const c of closers) await c()
  echo.close()
  web.close()
})

async function setup(resolve: Resolver, allow: string[] | (() => ReadonlySet<string>) = [], toPort = echoPort, allowLoopback = false) {
  const dialed: string[] = []
  const denied: string[] = []
  const resolved: string[] = []
  const proxy = await startSsrfProxy({
    allow: Array.isArray(allow) ? new Set(allow) : allow, webtermPort: SELF_PORT, allowLoopback,
    resolver: async (h) => { resolved.push(h); return resolve(h) },
    dial: (ip, port) => { dialed.push(`${ip}:${port}`); return connect({ host: '127.0.0.1', port: toPort }) },
    onDeny: (h, r) => { denied.push(`${h} ${r}`) },
  })
  closers.push(proxy.close)
  return { proxy, dialed, resolved, denied }
}

/** Kirim teks mentah ke proxy, kembalikan seluruh respons sampai koneksi ditutup / `until` terlihat. */
function raw(port: number, text: string, until?: string, then?: string): Promise<string> {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port })
    let buf = ''
    let sent = false
    s.on('data', (d) => {
      buf += d.toString()
      if (then && !sent && buf.includes('\r\n\r\n')) { sent = true; s.write(then) }
      if (until && buf.includes(until)) s.destroy()
    })
    s.on('close', () => resolve(buf))
    s.on('error', () => resolve(buf))
    s.write(text)
  })
}
const connectReq = (hp: string) => `CONNECT ${hp} HTTP/1.1\r\nHost: ${hp}\r\n\r\n`

test('CONNECT ke nama publik yang resolve ke loopback ditolak 403 tanpa dial', async () => {
  const t = await setup(async () => ['127.0.0.1'])
  const out = await raw(t.proxy.port, connectReq('evil.example:443'))
  expect(out).toContain('403 Forbidden')
  expect(out).toContain('blocked: private_host')
  expect(t.dialed.length).toBe(0)
})

test('rebinding: tersambung ke IP yang sudah divalidasi, resolve hanya sekali', async () => {
  let calls = 0
  const t = await setup(async () => (calls++ === 0 ? [PUBLIC_IP] : ['127.0.0.1']))
  const out = await raw(t.proxy.port, connectReq('rebind.example:443'), 'ping', 'ping')
  expect(out).toContain('200 Connection Established')
  expect(out).toContain('ping') // echo dari server tujuan lokal lewat terowongan
  expect(t.dialed.join()).toBe(`${PUBLIC_IP}:443`)
  expect(calls).toBe(1)
})

test('literal IP privat/metadata/mapped ditolak tanpa DNS dan tanpa dial', async () => {
  const t = await setup(async () => [PUBLIC_IP])
  for (const hp of ['169.254.169.254:80', '[::1]:80', '10.0.0.1:80', '[::ffff:127.0.0.1]:80', '100.64.0.1:80', '0.0.0.0:80']) {
    expect(await raw(t.proxy.port, connectReq(hp))).toContain('403 Forbidden')
  }
  expect(t.dialed.length).toBe(0)
  expect(t.resolved.length).toBe(0)
})

test('allowlist host:port lolos, port lain pada host sama tetap ditolak', async () => {
  const t = await setup(async () => ['127.0.0.1'], [allowKey('dev.local', 3000)])
  expect(await raw(t.proxy.port, connectReq('dev.local:3000'), 'Established')).toContain('200 Connection Established')
  expect(t.dialed.join()).toBe('127.0.0.1:3000')
  expect(await raw(t.proxy.port, connectReq('dev.local:3001'))).toContain('403 Forbidden')
})

test('port webterm pada loopback tak pernah lolos walau ada di allowlist', async () => {
  const t = await setup(async () => ['127.0.0.1'], [allowKey('127.0.0.1', SELF_PORT), allowKey('localhost', SELF_PORT)])
  expect(await raw(t.proxy.port, connectReq(`127.0.0.1:${SELF_PORT}`))).toContain('blocked: not_allowed_port')
  expect(await raw(t.proxy.port, connectReq(`localhost:${SELF_PORT}`))).toContain('blocked: not_allowed_port')
  expect(t.dialed.length).toBe(0)
})

test('DNS gagal atau kosong = 403 dns_fail; target malformed = 403', async () => {
  const bad = await setup(async () => { throw new Error('ENOTFOUND') })
  expect(await raw(bad.proxy.port, connectReq('nope.example:443'))).toContain('blocked: dns_fail')
  expect(bad.denied).toEqual(['nope.example dns_fail']) // reported to the runtime, which names it on the node
  expect(await raw(bad.proxy.port, 'GET http://Nope.Example/ HTTP/1.1\r\nHost: nope.example\r\n\r\n')).toContain('blocked: dns_fail')
  expect(bad.denied).toEqual(['nope.example dns_fail', 'nope.example dns_fail'])
  const empty = await setup(async () => [])
  expect(await raw(empty.proxy.port, connectReq('empty.example:443'))).toContain('blocked: dns_fail')
  expect(await raw(empty.proxy.port, connectReq('x.example:99999'))).toContain('blocked: not_allowed_port')
})

test('request absolut HTTP diteruskan ke IP tervalidasi; Host asli dipertahankan', async () => {
  const t = await setup(async () => [PUBLIC_IP], [], webPort)
  const out = await raw(t.proxy.port, 'GET http://pub.example/x?q=1 HTTP/1.1\r\nHost: pub.example\r\nProxy-Connection: keep-alive\r\nConnection: close\r\n\r\n')
  expect(out).toContain('200 OK')
  expect(out).toContain('hello pub.example')
  expect(t.dialed.join()).toBe(`${PUBLIC_IP}:80`)
})

test('request absolut ke host privat ditolak; bentuk origin-form (bukan proxy) = 400; bukan open relay', async () => {
  const t = await setup(async () => ['192.168.1.10'], [], webPort)
  expect(await raw(t.proxy.port, 'GET http://lan.example/ HTTP/1.1\r\nHost: lan.example\r\nConnection: close\r\n\r\n')).toContain('403 Forbidden')
  expect(await raw(t.proxy.port, 'GET /admin HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')).toContain('400 Bad Request')
  expect(await raw(t.proxy.port, 'GET https://pub.example/ HTTP/1.1\r\nHost: pub.example\r\nConnection: close\r\n\r\n')).toContain('400 Bad Request')
  expect(t.dialed.length).toBe(0)
})

test('bind loopback: localhost dev server lolos tanpa allowlist; port webterm, LAN, dan nama publik ke 127.0.0.1 tetap ditolak', async () => {
  const t = await setup(async (h) => (h === 'localhost' ? ['127.0.0.1'] : h === 'lan.example' ? ['192.168.1.10'] : ['127.0.0.1']), [], echoPort, true)
  expect(await raw(t.proxy.port, connectReq('localhost:3000'), 'Established')).toContain('200 Connection Established')
  expect(await raw(t.proxy.port, connectReq('127.0.0.1:5173'), 'Established')).toContain('200 Connection Established')
  expect(await raw(t.proxy.port, connectReq(`localhost:${SELF_PORT}`))).toContain('blocked: not_allowed_port')
  expect(await raw(t.proxy.port, connectReq('rebind.example:3000'))).toContain('blocked: private_host')
  expect(await raw(t.proxy.port, connectReq('lan.example:80'))).toContain('blocked: private_host')
  expect(await raw(t.proxy.port, connectReq('10.0.0.1:80'))).toContain('blocked: private_host')
})

test('allowlist getter dibaca ulang tiap koneksi (izin dari Pengaturan berlaku tanpa restart)', async () => {
  let allow: ReadonlySet<string> = new Set()
  const t = await setup(async () => ['192.168.1.10'], () => allow)
  expect(await raw(t.proxy.port, connectReq('nas.lan:8080'))).toContain('blocked: private_host')
  allow = new Set([allowKey('nas.lan', 8080)])
  expect(await raw(t.proxy.port, connectReq('nas.lan:8080'), 'Established')).toContain('200 Connection Established')
})
