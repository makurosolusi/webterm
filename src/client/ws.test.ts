import { test, expect, vi } from 'vitest'

class FakeWS {
  static instances: FakeWS[] = []
  static OPEN = 1
  static CONNECTING = 0
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) { FakeWS.instances.push(this) }
  send(d: string) { this.sent.push(d) }
  close() {}
}

;(globalThis as any).WebSocket = FakeWS

function setLocation(href: string, host: string) {
  ;(globalThis as any).location = { protocol: new URL(href).protocol, host, href }
}

/** Both modules read the token once at load, so every case needs a fresh module registry. */
function fresh() {
  vi.resetModules()
  return { ws: import('./ws'), api: import('./api') }
}

function lastSocket() {
  return FakeWS.instances[FakeWS.instances.length - 1]
}

test('first connect sends open exactly once (no doubled scrollback replay)', async () => {
  setLocation('http://localhost/', 'localhost')
  const { subscribe, send } = await fresh().ws
  const id = 'term-1'
  subscribe(id, () => {}, () => {}) // triggers connect(): socket is CONNECTING
  send({ t: 'open', id, cols: 80, rows: 24 }) // sent while not OPEN

  const sock = lastSocket()
  sock.readyState = FakeWS.OPEN
  sock.onopen!() // replays sub.open, then drains queue

  const opens = sock.sent
    .map((s) => JSON.parse(s))
    .filter((m) => m.t === 'open' && m.id === id)
  expect(opens).toHaveLength(1)
})

test('loopback default: no token means the WS url is byte-for-byte what it always was', async () => {
  ;(globalThis as any).sessionStorage = undefined
  setLocation('http://localhost/', 'localhost')
  const { subscribe } = await fresh().ws
  subscribe('term-token-off', () => {}, () => {})
  expect(lastSocket().url).toBe('ws://localhost/ws')
})

test('token in the page URL is stashed in sessionStorage and sent on the WS url', async () => {
  const stored = new Map<string, string>()
  ;(globalThis as any).sessionStorage = {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, v),
  }
  let replaced: string | null = null
  ;(globalThis as any).history = { replaceState: (_s: unknown, _t: string, u: string) => { replaced = u } }
  setLocation('http://10.0.0.5:8700/?token=s3cret%2Fx', '10.0.0.5:8700')

  const mods = fresh()
  const { tokenQuery } = await mods.api
  expect(tokenQuery()).toBe('token=s3cret%2Fx')
  expect(stored.get('webterm.token')).toBe('s3cret/x')
  expect(replaced).toBe('/') // token stripped from the address bar

  const { subscribe } = await mods.ws
  subscribe('term-token-on', () => {}, () => {})
  expect(lastSocket().url).toBe('ws://10.0.0.5:8700/ws?token=s3cret%2Fx')
})

// Perilaku LAMA: `open` disimpan APA ADANYA, jadi replay reconnect mengirim `resume: false` lagi.
// Selama PTY-nya hidup itu tak berakibat (server re-attach dan mengabaikan `cmd`/`resume`), tapi
// sesudah restart server replay itu benar-benar MELUNCURKAN `--session-id <sid>` pada id yang
// transcript-nya sudah ada — yang ditolak claude dengan "Session ID … is already in use."
const OLD_REPLAYED_RESUME = false

const SID = '11111111-2222-4333-8444-555555555555'

test('the replayed open resumes, while the first launch still mints the session id', async () => {
  setLocation('http://localhost/', 'localhost')
  const { subscribe, send } = await fresh().ws
  const id = 'agent-replay'
  subscribe(id, () => {}, () => {})
  const sock = lastSocket()
  sock.readyState = FakeWS.OPEN
  // Bentuk yang dikirim node agent yang lahir di sesi browser ini: `resume: false` (lihat
  // `resumesOnFirstLaunch` di AgentNode.tsx).
  send({ t: 'open', id, cols: 80, rows: 24, agentId: 'claude', sessionId: SID, resume: false })

  // Peluncuran PERTAMA tetap mencetak id-nya — tidak ada percakapan untuk disambung.
  expect(JSON.parse(sock.sent[0]).resume).toBe(false)

  sock.sent.length = 0
  sock.onopen!() // sambung ulang: inilah yang diputar ulang
  const replayed = JSON.parse(sock.sent[0])
  expect(replayed.resume).toBe(true)
  expect(replayed.sessionId).toBe(SID) // id yang SAMA: rantai sesi node tidak terputus
  expect(replayed.resume).not.toBe(OLD_REPLAYED_RESUME)
})

test('a plain terminal has nothing to resume, so its replayed open is byte-for-byte the same', async () => {
  setLocation('http://localhost/', 'localhost')
  const { subscribe, send, replayOpen } = await fresh().ws
  const id = 'term-replay'
  subscribe(id, () => {}, () => {})
  const sock = lastSocket()
  sock.readyState = FakeWS.OPEN
  const open = { t: 'open', id, cols: 80, rows: 24 } as const
  send(open)

  sock.sent.length = 0
  sock.onopen!()
  expect(sock.sent[0]).toBe(JSON.stringify(open))
  // Dan gerbangnya memang bentuk node-nya, bukan kebetulan: id tak sah / agent tanpa bentuk resume
  // yang membawa id juga lewat apa adanya — membalik `resume` di sana meluncurkan polos dan node
  // itu kehilangan rantai sesinya.
  const unsafe = { t: 'open', id, cols: 80, rows: 24, agentId: 'claude', sessionId: '-x; rm -rf /' } as const
  expect(replayOpen(unsafe)).toBe(unsafe)
})

// Perilaku LAMA: `open` yang diingat membawa `cols`/`rows` SAAT NODE LAHIR selamanya. Selama PTY-nya
// hidup itu tak berakibat — re-attach di server mengabaikan `cols`/`rows` — tapi sesudah restart
// server replay itu benar-benar MELUNCURKAN, dan `spawnPty` memakai ukuran lahir ini. Sejak SIGWINCH
// dikirim pada resize (commit 128c4ef) TUI benar-benar menggambar diri pada geometri salah itu.
const OLD_REPLAYED_COLS = 80
const OLD_REPLAYED_ROWS = 24

test('a resize updates the remembered open, so the replay carries the latest size', async () => {
  setLocation('http://localhost/', 'localhost')
  const { subscribe, send } = await fresh().ws
  const id = 'term-resized'
  subscribe(id, () => {}, () => {})
  const sock = lastSocket()
  sock.readyState = FakeWS.OPEN
  send({ t: 'open', id, cols: OLD_REPLAYED_COLS, rows: OLD_REPLAYED_ROWS })
  // Node diperbesar selagi socket-nya HIDUP: PTY ikut benar, tapi tidak ada apa pun yang tertinggal
  // di antrean untuk mengoreksi replay nanti.
  send({ t: 'resize', id, cols: 120, rows: 40 })

  sock.sent.length = 0
  sock.onopen!() // server restart / sambung ulang: replay mendarat di cabang spawn
  const replayed = JSON.parse(sock.sent[0])
  expect(replayed.t).toBe('open')
  expect(replayed.cols).toBe(120)
  expect(replayed.rows).toBe(40)
  expect(replayed.cols).not.toBe(OLD_REPLAYED_COLS)
  expect(replayed.rows).not.toBe(OLD_REPLAYED_ROWS)
})

test('a resize touches only cols/rows — the resume chain of the remembered open is untouched', async () => {
  setLocation('http://localhost/', 'localhost')
  const { subscribe, send } = await fresh().ws
  const id = 'agent-resized'
  subscribe(id, () => {}, () => {})
  const sock = lastSocket()
  sock.readyState = FakeWS.OPEN
  send({
    t: 'open', id, cols: 80, rows: 24, cwd: '/tmp/proj', cmd: 'claude',
    agentId: 'claude', sessionId: SID, resume: false,
  })
  send({ t: 'resize', id, cols: 100, rows: 30 })

  sock.sent.length = 0
  sock.onopen!()
  const replayed = JSON.parse(sock.sent[0])
  expect(replayed.cols).toBe(100)
  expect(replayed.rows).toBe(30)
  // Resize bukan pintu belakang untuk mengubah bentuk peluncuran: id sesi masih hanya dicetak sekali.
  expect(replayed.resume).toBe(true)
  expect(replayed.sessionId).toBe(SID)
  expect(replayed.cmd).toBe('claude')
  expect(replayed.cwd).toBe('/tmp/proj')
  expect(replayed.agentId).toBe('claude')
})

test('a resize for an id that never opened is forwarded without inventing an open to replay', async () => {
  setLocation('http://localhost/', 'localhost')
  const { subscribe, send } = await fresh().ws
  const id = 'term-no-open'
  subscribe(id, () => {}, () => {})
  const sock = lastSocket()
  sock.readyState = FakeWS.OPEN
  send({ t: 'resize', id, cols: 90, rows: 25 })

  sock.sent.length = 0
  sock.onopen!()
  expect(sock.sent.map((s) => JSON.parse(s).t)).not.toContain('open')
})

test('token survives a reload via sessionStorage, with no token in the URL', async () => {
  ;(globalThis as any).sessionStorage = {
    getItem: (k: string) => (k === 'webterm.token' ? 'kept' : null),
    setItem: () => {},
  }
  setLocation('http://10.0.0.5:8700/', '10.0.0.5:8700')
  const { tokenQuery } = await fresh().api
  expect(tokenQuery()).toBe('token=kept')
})

test('a reconnect resets each terminal before the server replays its scrollback', async () => {
  setLocation('http://localhost/', 'localhost')
  const { subscribe, send } = await fresh().ws
  const id = 'term-reconnect'
  let sentAtReset = -1
  const onReset = vi.fn(() => { sentAtReset = lastSocket().sent.length })
  subscribe(id, () => {}, () => {}, onReset)
  const first = lastSocket()
  first.readyState = FakeWS.OPEN
  send({ t: 'open', id, cols: 80, rows: 24 })
  first.onopen!()
  // First connect: the terminal is freshly mounted and empty — nothing to reset.
  expect(onReset).not.toHaveBeenCalled()

  vi.useFakeTimers()
  first.onclose!()              // socket dropped (e.g. a proxy idle-closed it)
  vi.advanceTimersByTime(1000)  // ws.ts schedules the reconnect 1s later
  vi.useRealTimers()
  const second = lastSocket()
  expect(second).not.toBe(first)
  second.readyState = FakeWS.OPEN
  second.onopen!()

  // Reconnect: the xterm still holds what it showed, so it is reset before the replay —
  // otherwise the replayed scrollback (the macOS banner) would stack a second copy.
  expect(onReset).toHaveBeenCalledTimes(1)
  expect(sentAtReset).toBe(0) // reset ran before the replayed open was sent
  expect(second.sent.map((s) => JSON.parse(s).t)).toContain('open') // replay still happens
})
