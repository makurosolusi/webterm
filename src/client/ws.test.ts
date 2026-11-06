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

// The reconnect/replay contract (since/reset/seq, offline input, backoff) lives in ws.reconnect.test.ts.

// `reason` membedakan proses yang keluar sendiri dari sesi yang ditutup. Server hanya tahu ADA
// yang meminta close, jadi client ini yang memutuskan apakah itu close-nya sendiri (`closed`,
// tidak perlu notice) atau close client lain (`peer-closed`, perlu notice netral).
test('an exit forwards self/undefined as-is and turns a peer close into peer-closed', async () => {
  setLocation('http://localhost/', 'localhost')
  const { subscribe, send } = await fresh().ws
  const onExit = vi.fn()
  subscribe('term-exit', () => {}, onExit)
  const sock = lastSocket()

  // Server bilang "ada yang close", tapi bukan kita: jangan senyapkan, beri notice netral.
  sock.onmessage!({ data: JSON.stringify({ t: 'exit', id: 'term-exit', code: 1, reason: 'closed' }) })
  expect(onExit).toHaveBeenLastCalledWith(1, 'peer-closed')

  // Close yang KITA minta: senyap.
  send({ t: 'close', id: 'term-exit' })
  sock.onmessage!({ data: JSON.stringify({ t: 'exit', id: 'term-exit', code: 0, reason: 'closed' }) })
  expect(onExit).toHaveBeenLastCalledWith(0, 'closed')

  sock.onmessage!({ data: JSON.stringify({ t: 'exit', id: 'term-exit', code: 0, reason: 'self' }) })
  expect(onExit).toHaveBeenLastCalledWith(0, 'self')

  // Server lama belum mengirim `reason`: parameternya tetap diteruskan sebagai undefined.
  sock.onmessage!({ data: JSON.stringify({ t: 'exit', id: 'term-exit', code: 0 }) })
  expect(onExit).toHaveBeenLastCalledWith(0, undefined)
})

// Close yang kita minta hanya menjelaskan SATU exit. Kalau tidak dikonsumsi, peer close berikutnya
// pada id yang sama ikut tersenyapkan.
test('the locally-requested close flag is consumed by one exit', async () => {
  setLocation('http://localhost/', 'localhost')
  const { subscribe, send } = await fresh().ws
  const onExit = vi.fn()
  subscribe('term-exit-once', () => {}, onExit)
  const sock = lastSocket()

  send({ t: 'close', id: 'term-exit-once' })
  sock.onmessage!({ data: JSON.stringify({ t: 'exit', id: 'term-exit-once', code: -1, reason: 'closed' }) })
  expect(onExit).toHaveBeenLastCalledWith(-1, 'closed')

  sock.onmessage!({ data: JSON.stringify({ t: 'exit', id: 'term-exit-once', code: -1, reason: 'closed' }) })
  expect(onExit).toHaveBeenLastCalledWith(-1, 'peer-closed')
})

// P0: exit tidak boleh memutar ulang `open` di reconnect. Server yang menerima `open` untuk id
// yang PTY-nya sudah mati akan MEN-SPAWN sesi baru (`--resume`), menimpa scrollback terakhir yang
// sedang dibaca pengguna.
test('P0: an exited session is not replayed on reconnect, so its final scrollback survives', async () => {
  setLocation('http://localhost/', 'localhost')
  const { subscribe, send } = await fresh().ws
  const id = 'term-exited-replay'
  const onExit = vi.fn()
  subscribe(id, () => {}, onExit)
  const sock = lastSocket()
  sock.readyState = FakeWS.OPEN
  send({ t: 'open', id, cols: 80, rows: 24 })

  sock.onmessage!({ data: JSON.stringify({ t: 'exit', id, code: 0, reason: 'self' }) })
  expect(onExit).toHaveBeenCalledTimes(1)

  sock.sent.length = 0
  sock.onopen!() // sambung ulang: replay `open` dulu akan meluncurkan PTY baru
  expect(sock.sent.map((s) => JSON.parse(s)).filter((m) => m.t === 'open' && m.id === id))
    .toHaveLength(0)
})

test('input typed after exit is dropped, not queued into a future spawn with the same id', async () => {
  setLocation('http://localhost/', 'localhost')
  const { subscribe, send } = await fresh().ws
  const id = 'term-exited-input'
  subscribe(id, () => {}, () => {})
  const sock = lastSocket()
  sock.readyState = FakeWS.OPEN
  send({ t: 'open', id, cols: 80, rows: 24 })
  sock.onmessage!({ data: JSON.stringify({ t: 'exit', id, code: 0, reason: 'self' }) })

  sock.sent.length = 0
  send({ t: 'input', id, data: 'ls\r' })
  expect(sock.sent).toHaveLength(0) // tidak dikirim ke sesi yang sudah mati

  sock.onopen!() // dan tidak muncul sebagai antrean reconnect
  expect(sock.sent.map((s) => JSON.parse(s)).filter((m) => m.t === 'input')).toHaveLength(0)
})

// `open` eksplisit = sesi baru untuk id itu (spawn ulang), jadi replay harus hidup lagi.
test('an explicit open after exit clears the exited flag and is replayed again', async () => {
  setLocation('http://localhost/', 'localhost')
  const { subscribe, send } = await fresh().ws
  const id = 'term-exited-reopen'
  subscribe(id, () => {}, () => {})
  const sock = lastSocket()
  sock.readyState = FakeWS.OPEN
  send({ t: 'open', id, cols: 80, rows: 24 })
  sock.onmessage!({ data: JSON.stringify({ t: 'exit', id, code: 0, reason: 'self' }) })

  send({ t: 'open', id, cols: 100, rows: 30 }) // sesi baru
  sock.sent.length = 0
  sock.onopen!()
  const opens = sock.sent.map((s) => JSON.parse(s)).filter((m) => m.t === 'open' && m.id === id)
  expect(opens).toHaveLength(1)
  expect(opens[0]).toMatchObject({ cols: 100, rows: 30 })
})

test('a remount clears the exited flag, so the fresh mount can replay its own open', async () => {
  setLocation('http://localhost/', 'localhost')
  const { subscribe, send } = await fresh().ws
  const id = 'term-exited-remount'
  const first = subscribe(id, () => {}, () => {})
  const sock = lastSocket()
  sock.readyState = FakeWS.OPEN
  send({ t: 'open', id, cols: 80, rows: 24 })
  sock.onmessage!({ data: JSON.stringify({ t: 'exit', id, code: 0, reason: 'self' }) })

  first() // unmount
  subscribe(id, () => {}, () => {}) // remount
  send({ t: 'open', id, cols: 90, rows: 25 })
  sock.sent.length = 0
  sock.onopen!()
  expect(sock.sent.map((s) => JSON.parse(s)).filter((m) => m.t === 'open' && m.id === id))
    .toHaveLength(1)
})

// P0: exit TIDAK boleh menutup id di client. Sesi yang lahir ulang dengan id sama (spawn ulang
// setelah close) harus bisa membuka lagi dan menerima output-nya — tombstone hanya milik server.
test('P0: an id can be re-opened after its exit and receives the fresh session output', async () => {
  setLocation('http://localhost/', 'localhost')
  const { subscribe, send } = await fresh().ws
  const id = 'term-reopen'
  const onExit = vi.fn()
  const onOutput = vi.fn()
  subscribe(id, onOutput, onExit)
  const sock = lastSocket()
  sock.readyState = FakeWS.OPEN
  send({ t: 'open', id, cols: 80, rows: 24 })

  sock.onmessage!({ data: JSON.stringify({ t: 'exit', id, code: -1, reason: 'closed' }) })
  expect(onExit).toHaveBeenCalledTimes(1)

  sock.sent.length = 0
  send({ t: 'open', id, cols: 100, rows: 30 }) // sesi baru, id yang sama
  expect(sock.sent).toHaveLength(1)
  expect(JSON.parse(sock.sent[0])).toMatchObject({ t: 'open', id, cols: 100, rows: 30 })

  sock.onmessage!({ data: JSON.stringify({ t: 'output', id, data: 'fresh', seq: 1 }) })
  expect(onOutput).toHaveBeenCalledWith('fresh')
  expect(onExit).toHaveBeenCalledTimes(1) // exit lama tidak diputar ulang ke sesi baru
})

test('onReconnect: silent on first connect, fires once per later open, off works, a throwing listener is isolated', async () => {
  setLocation('http://localhost/', 'localhost')
  const { subscribe, onReconnect } = await fresh().ws
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const bad = vi.fn(() => { throw new Error('boom') })
  const good = vi.fn()
  const gone = vi.fn()
  onReconnect(bad)
  onReconnect(good)
  onReconnect(gone)()
  subscribe('term-onreconnect', () => {}, () => {})
  const first = lastSocket()
  first.readyState = FakeWS.OPEN
  first.onopen!()
  expect(good).not.toHaveBeenCalled()
  expect(bad).not.toHaveBeenCalled()

  vi.useFakeTimers()
  first.onclose!()
  vi.advanceTimersByTime(1000)
  vi.useRealTimers()
  const second = lastSocket()
  second.readyState = FakeWS.OPEN
  second.onopen!()
  expect(bad).toHaveBeenCalledTimes(1)
  expect(good).toHaveBeenCalledTimes(1) // listener sebelumnya yang melempar tidak menghalangi
  expect(gone).not.toHaveBeenCalled()
  expect(warn).toHaveBeenCalledTimes(1)
  warn.mockRestore()
})
