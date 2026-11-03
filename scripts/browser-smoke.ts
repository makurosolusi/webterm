// Smoke Chrome NYATA untuk node Browser (bukan bagian `npm test`): WEBTERM_BROWSER_SMOKE=on bun scripts/browser-smoke.ts
// Menjalankan server uji di PORT sendiri + data dir /tmp terisolasi + fixture HTTP loopback; semua anak dimatikan di akhir.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeFrameHeader } from '../src/shared/browser.wire'

declare const Bun: { serve(o: { hostname: string; port: number; fetch(r: Request): Response }): { port: number; stop(f?: boolean): void } }
if (process.env.WEBTERM_BROWSER_SMOKE !== 'on') { console.error('set WEBTERM_BROWSER_SMOKE=on untuk menjalankan smoke Chrome nyata'); process.exit(2) }

const PORT = Number(process.env.WEBTERM_SMOKE_PORT) || 8791
const DISCARD_MS = 1_500 // pendek supaya skenario discard/pulih tak menunggu 5 menit bawaan
const NODE = 'smoke-node'
const WORKSPACE = 'smoke-ws'
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const events: string[] = [] // dicatat fixture dari halaman yang benar-benar jalan di Chrome
const page = (title: string, extra = '') => `<!doctype html><title>${title}</title><body style="margin:0;background:#2a6">
<button id=b style="position:absolute;left:100px;top:100px;width:200px;height:80px" onclick="fetch('/log?e=click')">klik</button>
<input id=i autofocus style="position:absolute;left:100px;top:300px;width:300px;height:40px" oninput="fetch('/log?e=input:'+encodeURIComponent(this.value))">
<script>fetch('/log?e=load:'+encodeURIComponent(location.pathname)+':'+innerWidth+'x'+innerHeight);let z='';setInterval(()=>{const n=innerWidth+'x'+innerHeight;if(n!==z){z=n;fetch('/log?e=size:'+n)}},100)</script>${extra}</body>`
const fixture = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  fetch(req) {
    const u = new URL(req.url)
    if (u.pathname === '/log') { events.push(u.searchParams.get('e') ?? ''); return new Response('ok') }
    return new Response(page(u.pathname === '/b' ? 'Halaman B' : 'Halaman A'), { headers: { 'content-type': 'text/html' } })
  },
})
const dataDir = mkdtempSync(join(tmpdir(), 'webterm-browser-smoke-'))
const base = `http://127.0.0.1:${fixture.port}`
const server = spawn('bun', ['src/server/index.ts'], {
  stdio: ['ignore', 'ignore', 'pipe'],
  env: { ...process.env, NODE_ENV: 'production', PORT: String(PORT), HOST: '127.0.0.1', WEBTERM_DATA_DIR: dataDir, WEBTERM_BROWSER: 'on', WEBTERM_BROWSER_DISCARD_MS: String(DISCARD_MS), WEBTERM_BROWSER_ALLOW_HOSTS: `127.0.0.1:${fixture.port}`, WEBTERM_TOKEN: '' },
})
let serverErr = ''
server.stderr?.on('data', (b) => { serverErr = (serverErr + b).slice(-2000); if (process.env.WEBTERM_SMOKE_KEEP === 'on') process.stderr.write(b) })

const results: Array<[string, boolean, string]> = []
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok, detail]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`) }
async function until(cond: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await sleep(50) } return cond() }

async function main() {
  const api = `http://127.0.0.1:${PORT}`
  const up = async () => { try { return (await fetch(`${api}/api/browser/status`)).ok } catch { return false } } // belum listen = false, bukan galat
  check('server naik', await until(up, 10_000), serverErr.slice(-200))
  const st = await (await fetch(`${api}/api/browser/status`)).json() as Record<string, unknown>
  check('status enabled+binFound', st.enabled === true && st.binFound === true, JSON.stringify(st))

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/browser?workspaceId=${WORKSPACE}`)
  ws.binaryType = 'arraybuffer'
  const states: Array<Record<string, unknown>> = [], errors: unknown[] = []
  const frames: Uint8Array[] = []
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') { const m = JSON.parse(e.data); if (m.t === 'state') states.push(m); else if (m.t === 'error') errors.push(m) } else {
      const b = new Uint8Array(e.data as ArrayBuffer); const h = decodeFrameHeader(b)
      if (h) { frames.push(b.subarray(h.offset)); ws.send(JSON.stringify({ t: 'ack', id: NODE, seq: h.seq })) }
    }
  }
  await new Promise<void>((r, j) => { ws.onopen = () => r(); ws.onerror = () => j(new Error('ws error')) })
  const send = (m: object) => ws.send(JSON.stringify({ id: NODE, ...m }))
  const last = () => states[states.length - 1] ?? {}
  const mouse = (type: string, x: number, y: number) => send({ t: 'mouse', type, x, y, button: 'left', buttons: type === 'up' ? 0 : 1, clickCount: 1 })
  const waitEv = (p: string, ms?: number) => until(() => events.some((e) => e.startsWith(p)), ms)
  const isJpeg = (f?: Uint8Array) => !!f && f.length > 100 && f[0] === 0xff && f[1] === 0xd8 && f[2] === 0xff

  send({ t: 'attach', w: 800, h: 600, dpr: 1 })
  check('attach -> state live', await until(() => last().live === 'live'), JSON.stringify(errors))
  send({ t: 'nav', action: 'go', url: `${base}/a` })
  check('navigasi: halaman fixture termuat di Chrome', await waitEv('load:/a'), events.join('|'))
  check('state: url+title', await until(() => last().title === 'Halaman A'), `${last().url} / ${last().title}`)
  check('frame JPEG valid (magic FFD8FF, >100B)', await until(() => frames.some(isJpeg)), `frames=${frames.length} first=${frames[0]?.length}`)
  check('viewport = ukuran attach', events.some((e) => e === 'load:/a:800x600'), events.join('|'))

  mouse('move', 150, 130); mouse('down', 150, 130); mouse('up', 150, 130)
  check('klik mouse sampai ke halaman', await waitEv('click'), events.join('|'))
  mouse('down', 200, 320); mouse('up', 200, 320) // fokus ke input
  await sleep(300)
  for (const ch of 'hai') {
    const code = `Key${ch.toUpperCase()}`
    send({ t: 'key', type: 'down', key: ch, code, text: ch, vk: ch.toUpperCase().charCodeAt(0), mods: 0 }); send({ t: 'key', type: 'up', key: ch, code, text: '', vk: ch.toUpperCase().charCodeAt(0), mods: 0 })
  }
  check('ketik (key) sampai ke input', await waitEv('input:hai'), events.join('|'))
  send({ t: 'text', text: '!' })
  check('ketik (text/insertText) sampai ke input', await waitEv('input:hai!'), events.join('|'))

  const framesBefore = frames.length
  send({ t: 'nav', action: 'go', url: `${base}/b` })
  check('navigasi ke /b + canBack', await until(() => last().title === 'Halaman B' && last().canBack === true), `${last().title} back=${last().canBack}`)
  check('frame baru setelah navigasi (screencast tetap hidup)', await until(() => frames.length > framesBefore), `before=${framesBefore} after=${frames.length}`)
  send({ t: 'nav', action: 'back' })
  check('back -> /a, canForward', await until(() => last().title === 'Halaman A' && last().canForward === true), `${last().title}`)
  send({ t: 'nav', action: 'forward' })
  check('forward -> /b', await until(() => last().title === 'Halaman B'), `${last().title}`)
  const loads = events.filter((e) => e.startsWith('load:/b')).length
  send({ t: 'nav', action: 'reload' })
  check('reload memuat ulang halaman', await until(() => events.filter((e) => e.startsWith('load:/b')).length > loads), events.join('|'))

  send({ t: 'resize', w: 640, h: 480, dpr: 1 })
  check('resize mengubah viewport halaman', await waitEv('size:640x480'), events.join('|'))
  send({ t: 'nav', action: 'go', url: 'http://10.0.0.1/' })
  check('SSRF: IP privat tak di-allowlist ditolak (blocked)', await until(() => errors.some((e) => (e as { code?: string }).code === 'blocked')), JSON.stringify(errors))

  send({ t: 'detach' })
  const liveCount = async () => ((await (await fetch(`${api}/api/browser/status`)).json()) as { live: number }).live
  check('detach -> tab di-discard setelah DISCARD_MS (live=0)', await until(async () => (await liveCount()) === 0, 10_000))
  const before = events.filter((e) => e.startsWith('load:/b')).length
  send({ t: 'attach', w: 800, h: 600, dpr: 1 })
  check('attach ulang memulihkan URL terakhir (/b)', await until(() => events.filter((e) => e.startsWith('load:/b')).length > before), events.join('|'))
  ws.close()
  check('tidak ada galat tak terduga', errors.every((e) => (e as { code?: string }).code === 'blocked'), JSON.stringify(errors))
}

async function chromeAlive(): Promise<boolean> {
  const p = spawn('pgrep', ['-f', `user-data-dir=${dataDir}`]); let out = ''
  p.stdout.on('data', (b) => { out += b })
  await new Promise((r) => p.once('close', r))
  return out.trim().length > 0
}
try { await main() } catch (e) { check('skrip tanpa pengecualian', false, e instanceof Error ? e.message : String(e)) } finally {
  server.kill('SIGTERM')
  await new Promise<void>((r) => { const t = setTimeout(() => { server.kill('SIGKILL'); r() }, 8_000); server.once('exit', () => { clearTimeout(t); r() }) })
  check('Chrome mati setelah server berhenti', await until(async () => !(await chromeAlive()), 15_000))
  fixture.stop(true)
  if (process.env.WEBTERM_SMOKE_KEEP === 'on') console.log(`data dir dipertahankan: ${dataDir}`)
  else rmSync(dataDir, { recursive: true, force: true })
  const bad = results.filter((r) => !r[1])
  console.log(bad.length ? `GAGAL: ${bad.length}/${results.length}` : `LULUS: ${results.length}/${results.length}`)
  process.exit(bad.length ? 1 : 0)
}
