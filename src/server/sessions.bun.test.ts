// Bun-only (needs Bun.Terminal via spawnPty); runs under `bun test`, excluded
// from vitest. Ambient types for 'bun:test' live in ./bun-test.d.ts. The pure launch-line tests
// live in sessions.launch.bun.test.ts.
import { test, expect, afterAll } from 'bun:test'
import { reapChildren } from './processReap.testutil'
// No PTY child may outlive this file: bun's own dangling-process kill can deadlock on one (processReap.testutil.ts).
afterAll(() => reapChildren())
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `launchLine` untuk claude menulis file settings sungguhan: seluruh file diisolasi ke temp supaya
// test tidak pernah menyentuh data dir pengguna.
const DATA_DIR = mkdtempSync(join(tmpdir(), 'webterm-sessions-'))
process.env.WEBTERM_DATA_DIR = DATA_DIR
// HOME diisolasi: test ini menguji perilaku sesi/PTY, bukan shell rc milik user — `bash -l` yang
// membaca rc berat (brew/pyenv/nvm/rvm/conda) hanya menambah latensi start yang tak berhubungan.
const ORIGINAL_HOME = process.env.HOME
process.env.HOME = DATA_DIR
// Tiap run membuat satu direktori temp baru; tanpa pembersihan, /tmp menumpuk ratusan direktori
// `webterm-sessions-*` setelah beberapa hari CI lokal. HOME dikembalikan karena seluruh file test
// berbagi satu proses: `ptySpawn.bun.test.ts` membaca `process.env.HOME`.
afterAll(() => {
  process.env.HOME = ORIGINAL_HOME
  rmSync(DATA_DIR, { recursive: true, force: true })
})

import type { ServerMsg } from '../shared/protocol'
import { Sessions } from './sessions'
import { SETTING_RANGES } from '../shared/settings.ranges'
import type { AgentStatus } from '../shared/workspace'
import { NODE_TOKEN_ENV, nodeToken } from './hooks'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function collector() {
  const chunks: string[] = []
  const exits: { code: number; reason?: string }[] = []
  const send = (m: ServerMsg) => {
    if (m.t === 'output') chunks.push(m.data)
    else if (m.t === 'exit') exits.push({ code: m.code, reason: m.reason })
  }
  return { send, exits, joined: () => chunks.join('') }
}

/** Poll `get()` sampai `needle` muncul; timeout adalah GAGAL berdiagnosis, bukan lewat diam-diam.
 *  Dulu fungsi ini kembali tanpa pesan, jadi test yang kehabisan waktu hanya merah di assertion
 *  berikutnya tanpa menyebut marker mana yang hilang atau berapa lama ditunggu. Anggaran default
 *  dinaikkan ke 10 s karena peluncuran login shell nyata bisa tertunda belasan detik saat suite
 *  penuh berjalan bersamaan. */
async function pollFor(get: () => string, needle: string, maxMs = 20_000, label = ''): Promise<void> {
  const started = Date.now()
  const deadline = started + maxMs
  while (Date.now() < deadline) {
    if (get().includes(needle)) return
    await sleep(50)
  }
  const elapsed = Date.now() - started
  const tail = get().slice(-300)
  throw new Error(
    `pollFor timed out after ${elapsed}ms (budget ${maxMs}ms) waiting for ${JSON.stringify(needle)}` +
      `${label ? ` [${label}]` : ''}; last output tail=${JSON.stringify(tail)}`
  )
}

test('open on a live id adds a subscriber, replays scrollback only to the joiner, and detach is per-subscriber', async () => {
  const s = new Sessions()
  const a = collector()
  try {
    s.open({ t: 'open', id: 't1', cols: 80, rows: 24 }, a.send)

    // Marker output sengaja beda dari teks yang diketik: `echo` terminal ikut masuk scrollback, jadi
    // marker `SCROLL_ONCE_9f3a` hanya muncul SEKALI (dari output perintah), bukan dari echo barisnya.
    s.input('t1', "printf 'SCROLL_ONCE_%s\\n' 9f3a\n")
    await pollFor(a.joined, 'SCROLL_ONCE_9f3a', 30_000)
    expect(a.joined()).toContain('SCROLL_ONCE_9f3a')

    // Re-attach: pelanggan BARU ikut set, dan scrollback diputar SEKALI ke dia saja.
    const b = collector()
    s.open({ t: 'open', id: 't1', cols: 80, rows: 24 }, b.send)
    expect(b.joined()).toContain('SCROLL_ONCE_9f3a')
    expect(b.joined().split('SCROLL_ONCE_9f3a').length - 1).toBe(1)
    // Pelanggan LAMA tidak menerima putaran ulang itu: dua kali berarti `open` masih memutar buffer
    // ke semua orang, bukan hanya ke pendatang baru.
    expect(a.joined().split('SCROLL_ONCE_9f3a').length - 1).toBe(1)

    // ...dan pelanggan lama TETAP menerima output baru sesudah re-attach.
    s.input('t1', "printf 'AFTER_JOIN_%s\\n' 9f3a\n")
    await pollFor(a.joined, 'AFTER_JOIN_9f3a')
    await pollFor(b.joined, 'AFTER_JOIN_9f3a')
    expect(a.joined()).toContain('AFTER_JOIN_9f3a')
    expect(b.joined()).toContain('AFTER_JOIN_9f3a')

    // Detach hanya melepas pelanggan ITU, bukan sesinya: PTY tetap hidup, dan `a` tetap mendengar.
    s.detach(b.send)
    s.input('t1', "printf 'STILL_ALIVE_%s\\n' 9f3a\n")
    await pollFor(a.joined, 'STILL_ALIVE_9f3a')
    expect(a.joined()).toContain('STILL_ALIVE_9f3a')
    expect(b.joined()).not.toContain('STILL_ALIVE_9f3a')

    const c = collector()
    s.open({ t: 'open', id: 't1', cols: 80, rows: 24 }, c.send)
    expect(c.joined()).toContain('STILL_ALIVE_9f3a')

    // close() kills the pty and drops the session. Re-opening the same id now
    // spawns a FRESH shell with an empty buffer, so the replay carries none of
    // the old scrollback — proof the previous session is truly gone.
    s.close('t1')
    // `close` mengabarkan kematian yang KITA minta: tepat satu `exit`, dan alasannya 'closed'.
    expect(a.exits.length).toBe(1)
    expect(a.exits[0].reason).toBe('closed')
    expect(a.exits[0].code).toBe(-1)
    const d = collector()
    s.open({ t: 'open', id: 't1', cols: 80, rows: 24 }, d.send)
    expect(d.joined()).toBe('')
  } finally {
    // PTY harus mati walau assertion di atas gagal: shell yang bocor menumpuk beban untuk run
    // berikutnya, dan tumpukan itulah yang membuat test PTY lain ikut merah di suite penuh.
    s.close('t1')
  }
}, 90_000)

test('open with a cmd launches it through the login shell', async () => {
  const s = new Sessions()
  const a = collector()
  try {
    s.open({ t: 'open', id: 'c1', cols: 80, rows: 24, cmd: 'echo hi' }, a.send)
    await pollFor(a.joined, 'hi')
    expect(a.joined()).toContain('hi')
  } finally {
    s.close('c1')
  }
}, 90_000)


test('a missing wrapper degrades to the bare command and says so once', async () => {
  const s = new Sessions()
  const a = collector()
  try {
    s.open(
      { t: 'open', id: 'w1', cols: 80, rows: 24, cmd: 'webterm-missing-wrapper-9f3a -e p -- echo WRAPPED_OK' },
      a.send
    )
    await pollFor(a.joined, 'WRAPPED_OK')
    expect(a.joined()).toContain('WRAPPED_OK')              // perintah polos benar-benar berjalan
    expect(a.joined()).toContain(`'webterm-missing-wrapper-9f3a' was not found`)
    expect(a.joined().includes('load envman')).toBe(false)
  } finally {
    s.close('w1')
  }
}, 90_000)

// --- Env hook ------------------------------------------------------------------------------------

test('a claude session carries its header file (not the token) and the token dies when the session closes', async () => {
  const s = new Sessions()
  const a = collector()
  try {
    // Tanpa sessionId supaya perintahnya lolos apa adanya; gerbang env dipegang agentId, bukan cmd.
    // Env hanya membawa PATH file header (token di env terbaca proses ber-uid sama); file itu
    // berisi token node ini. Yang dicetak hitungan, bukan nilai.
    s.open(
      { t: 'open', id: 'h1', cols: 80, rows: 24, cmd: `echo "tok_env_len:\${#${NODE_TOKEN_ENV}} hdr_has_tok:$(grep -c "${nodeToken('h1')}" "$WEBTERM_NODE_HEADERS")"`, agentId: 'claude' },
      a.send
    )
    await pollFor(a.joined, 'hdr_has_tok:')
    expect(a.joined()).toContain('tok_env_len:0 hdr_has_tok:2')

    // Token per-node tidak boleh tetap sah setelah sesinya mati: node id bisa dipakai ulang sesi
    // berikutnya, jadi `close` harus melupakannya dan permintaan berikut mencetak token BARU.
    const before = nodeToken('h1')
    s.close('h1')
    expect(nodeToken('h1') === before).toBe(false)
  } finally {
    s.close('h1')
  }
}, 90_000)

// --- Status awal sebuah sesi agent -------------------------------------------------------------

test('a freshly spawned agent session reports NO status until something real says so', async () => {
  const s = new Sessions()
  // Bentuk LAMA yang harus tetap mati: `open` menulis 'working' untuk tiap sesi ber-agentId, jadi
  // node claude yang baru lahir — masih memuat banner, belum pernah diberi prompt — terbaca RUNNING
  // dan ikut terhitung di seksi Running. Yang dijaga test ini adalah itu, bukan jumlah pesannya.
  const OLD_STATUS_AT_SPAWN: AgentStatus = 'working'
  // `status` bisa ABSEN di kawat ("tidak ada status"), dan di sini bedanya dengan SENYAP harus
  // terlihat: `join` saja tidak cukup karena `[undefined].join(',')` juga '', jadi absen dipetakan
  // ke 'NONE' dan yang diperiksa adalah daftar pesannya, bukan hasil gabungnya.
  const seen: string[] = []
  const send = (m: ServerMsg) => { if (m.t === 'status') seen.push(m.status ?? 'NONE') }
  try {
    // `sleep` supaya PTY-nya tetap hidup: sesi yang keluar memancarkan 'done' lewat onExit dan itu
    // akan mengaburkan apa yang sedang diuji.
    s.open({ t: 'open', id: 'st1', cols: 80, rows: 24, cmd: 'sleep 5', agentId: 'claude' }, send)

    // Sesi BARU memancarkan TEPAT SATU pesan, dan isinya PENCABUTAN: 'NONE' di sini berarti "server
    // tidak punya status untuk node ini", BUKAN senyap. Senyap pun salah — client memegang salinan
    // status per node yang bertahan melewati reconnect, jadi `open` yang diputar ulang sesudah server
    // restart (map proses baru kosong → mendarat di cabang spawn) butuh jawaban eksplisit.
    // Snapshot, bukan array hidup: `open` kedua di bawah kini MENAMBAH pelanggan (bukan mengganti
    // `send`), jadi `seen` tetap berlangganan dan akan ikut menerima `working` dari `setStatus` nanti.
    const atSpawn = seen.slice()
    expect(atSpawn.length).toBe(1)
    expect(atSpawn[0]).toBe('NONE')
    // Dan yang dipancarkan bukan nilai AgentStatus yang dikarang: regresi aslinya tetap tergigit.
    expect(atSpawn.join(',')).not.toContain(OLD_STATUS_AT_SPAWN)

    // Dan tidak ada status yang DISIMPAN diam-diam. Socket yang re-attach sekarang selalu dijawab,
    // tapi jawabannya "tidak ada status" — bukan satu pun nilai AgentStatus yang dikarang.
    const again: string[] = []
    s.open({ t: 'open', id: 'st1', cols: 80, rows: 24, agentId: 'claude' }, (m) => { if (m.t === 'status') again.push(m.status ?? 'NONE') })
    expect(again.join(',')).toBe('NONE')
    expect(again.join(',')).not.toContain(OLD_STATUS_AT_SPAWN)

    // Sinyal nyata (jalur yang dipakai hook UserPromptSubmit) tetap sampai ke client. Ia juga yang
    // membuktikan dua predikat `not.toContain` di atas tidak hijau secara hampa: 'working' MEMANG
    // bisa muncul di daftar ini, cuma tidak boleh lahir dari spawn.
    s.setStatus('st1', 'working')
    expect(again.join(',')).toBe('NONE,working')
  } finally {
    s.close('st1')
  }
}, 90_000)

test('a plain terminal gets no hook token at all', async () => {
  const s = new Sessions()
  const a = collector()
  try {
    s.open(
      { t: 'open', id: 'h2', cols: 80, rows: 24, cmd: `echo "tok_len:\${#${NODE_TOKEN_ENV}}"` },
      a.send
    )
    await pollFor(a.joined, 'tok_len:')
    expect(a.joined()).toContain('tok_len:0')
  } finally {
    s.close('h2')
  }
}, 90_000)


test('a configured shell is the one that actually runs the command', async () => {
  const s = new Sessions({ shell: '/bin/sh' })
  const a = collector()
  try {
    s.open({ t: 'open', id: 'sh1', cols: 80, rows: 24, cmd: 'echo "ran_in:$0"' }, a.send)
    await pollFor(a.joined, 'ran_in:')
    expect(a.joined()).toContain('ran_in:/bin/sh')
  } finally {
    s.close('sh1')
  }
}, 90_000)

test('the scrollback limit drops old output and keeps the newest', async () => {
  // Terkecil yang diizinkan tabel rentang: nilai di bawahnya dijepit naik, jadi 512 tak lagi berarti.
  const s = new Sessions({ scrollbackBytes: SETTING_RANGES.scrollbackBytes.min })
  const a = collector()
  try {
    s.open({ t: 'open', id: 'sb1', cols: 80, rows: 24 }, a.send)

    // Marker disusun shell ($((..))) agar echo tty tidak cocok: login shell lambat start, input berikutnya harus menunggu shell hidup.
    // Dua putaran di bawah memakai anggaran 20 s: satu login shell nyata bisa butuh >10 s saat mesin
    // sibuk, dan kegagalan di sini harus datang dari `pollFor` dengan marker + elapsed, bukan timeout runner.
    s.input('sb1', 'echo FIRST_MARKER_$((9*1))f3a\n')
    await pollFor(() => s.getTerminal('sb1'), 'FIRST_MARKER_9f3a', 20_000, 'sb1 first marker')
    expect(s.getTerminal('sb1')).toContain('FIRST_MARKER_9f3a')

    // Lebih dari batas minimum (16 KiB) output sesudahnya harus mendorong marker pertama keluar ring buffer.
    s.input('sb1', 'for i in $(seq 1 400); do echo pad-$i-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; done\n')
    s.input('sb1', 'echo LAST_MARKER_9f3a\n')
    await pollFor(() => s.getTerminal('sb1'), 'LAST_MARKER_9f3a', 20_000, 'sb1 last marker')

    const kept = s.getTerminal('sb1')
    expect(kept).toContain('LAST_MARKER_9f3a')
    expect(kept.includes('FIRST_MARKER_9f3a')).toBe(false)
  } finally {
    s.close('sb1')
  }
}, 90_000)

test('an unusable scrollback setting falls back to the default instead of losing output', async () => {
  // Shell polos (tanpa cmd) supaya sesi tetap hidup: sesi yang keluar dihapus dari map, sehingga
  // getTerminal akan mengembalikan string kosong dan menguji hal yang salah.
  for (const bad of [0, -1, NaN, Number.POSITIVE_INFINITY]) {
    const s = new Sessions({ scrollbackBytes: bad })
    const a = collector()
    try {
      s.open({ t: 'open', id: 'sb2', cols: 80, rows: 24 }, a.send)
      s.input('sb2', 'echo KEEP_ME_9f3a\n')
      await pollFor(() => s.getTerminal('sb2'), 'KEEP_ME_9f3a', 10_000, `sb2 bad=${bad}`)
      expect(s.getTerminal('sb2')).toContain('KEEP_ME_9f3a')
    } finally {
      s.close('sb2')
    }
  }
}, 90_000)
