// Bun-only (needs Bun.Terminal via spawnPty); runs under `bun test`, excluded
// from vitest. Ambient types for 'bun:test' live in ./bun-test.d.ts.
import { test, expect } from 'bun:test'
import type { OpenMsg, ServerMsg } from '../shared/protocol'
import { Sessions, launchLine } from './sessions'
import { binaryExists, shellArgv, unwrapMissingWrapper } from './pty'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function collector() {
  const chunks: string[] = []
  const send = (m: ServerMsg) => { if (m.t === 'output') chunks.push(m.data) }
  return { send, joined: () => chunks.join('') }
}

async function pollFor(get: () => string, needle: string, maxMs = 3000) {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    if (get().includes(needle)) return
    await sleep(50)
  }
}

test('pty survives detach and replays scrollback on re-attach', async () => {
  const s = new Sessions()
  const a = collector()
  s.open({ t: 'open', id: 't1', cols: 80, rows: 24 }, a.send)

  s.input('t1', 'echo HELLO_WEBTERM\n')
  await pollFor(a.joined, 'HELLO_WEBTERM')
  expect(a.joined()).toContain('HELLO_WEBTERM')

  // Re-attach a fresh subscriber: scrollback replays immediately (refresh survival).
  const b = collector()
  s.open({ t: 'open', id: 't1', cols: 80, rows: 24 }, b.send)
  expect(b.joined()).toContain('HELLO_WEBTERM')

  // Detach must NOT kill the pty: it still accepts input and keeps buffering.
  s.detach(b.send)
  s.input('t1', 'echo STILL_ALIVE\n')
  const c = collector()
  await pollFor(() => { s.open({ t: 'open', id: 't1', cols: 80, rows: 24 }, c.send); return c.joined() }, 'STILL_ALIVE')
  expect(c.joined()).toContain('STILL_ALIVE')

  // close() kills the pty and drops the session. Re-opening the same id now
  // spawns a FRESH shell with an empty buffer, so the replay carries none of
  // the old scrollback — proof the previous session is truly gone.
  s.close('t1')
  const d = collector()
  s.open({ t: 'open', id: 't1', cols: 80, rows: 24 }, d.send)
  expect(d.joined()).toBe('')
  s.close('t1')
})

test('open with a cmd launches it through the login shell', async () => {
  const s = new Sessions()
  const a = collector()
  s.open({ t: 'open', id: 'c1', cols: 80, rows: 24, cmd: 'echo hi' }, a.send)
  await pollFor(a.joined, 'hi')
  expect(a.joined()).toContain('hi')
  s.close('c1')
})

// --- Perakitan baris peluncuran (murni, tanpa PTY) -------------------------------------------

const SID = '11111111-2222-3333-4444-555555555555'
const open = (over: Partial<OpenMsg>): OpenMsg =>
  ({ t: 'open', id: 'n1', cols: 80, rows: 24, ...over })

test('launchLine mints the session id with each harness own grammar', () => {
  // claude: flag id spasi-terpisah PLUS objek hook --settings.
  const claude = launchLine(open({ cmd: 'claude', agentId: 'claude', sessionId: SID }), 9999)
  expect(claude).toContain(`--session-id ${SID}`)
  expect(claude).toContain('--settings ')
  expect(claude).toContain('127.0.0.1:9999')

  // copilot: bentuk `=`, dan TIDAK mengerti --settings.
  const copilot = launchLine(open({ cmd: 'copilot', agentId: 'copilot', sessionId: SID }), 9999)
  expect(copilot).toBe(`copilot --session-id=${SID}`)

  // cursor: tak punya flag session-id sama sekali — ia mengadopsi id lewat --resume <id baru>.
  const cursor = launchLine(open({ cmd: 'cursor-agent', agentId: 'cursor', sessionId: SID }), 9999)
  expect(cursor).toBe(`cursor-agent --resume ${SID}`)

  // codex & gemini resumable tapi BUKAN session-id-capable: peluncuran pertama harus identik
  // byte demi byte dengan perintah dasar.
  for (const id of ['codex', 'gemini'] as const) {
    expect(launchLine(open({ cmd: id, agentId: id, sessionId: SID }), 9999)).toBe(id)
  }

  // Terminal biasa (tanpa agentId) dan agent tanpa session id: perintah apa adanya.
  expect(launchLine(open({ cmd: 'htop' }), 9999)).toBe('htop')
  expect(launchLine(open({ cmd: 'claude', agentId: 'claude' }), 9999)).toBe('claude')
  expect(launchLine(open({ agentId: 'claude', sessionId: SID }), 9999)).toBe(undefined)
})

test('launchLine resumes with the harness resume grammar', () => {
  const r = (agentId: string, cmd: string) =>
    launchLine(open({ cmd, agentId, sessionId: SID, resume: true }), 9999)
  expect(r('claude', 'claude')).toContain(`--resume ${SID}`)
  expect(r('codex', 'codex')).toBe(`codex resume ${SID}`)
  expect(r('copilot', 'copilot')).toBe(`copilot --resume=${SID}`)
  expect(r('antigravity', 'agy')).toBe(`agy --conversation=${SID}`)
  // Pembungkus tetap utuh: perintah client dipakai sebagai program secara keseluruhan.
  expect(r('codex', 'envman -e p -- codex')).toBe(`envman -e p -- codex resume ${SID}`)
  // Agent tak dikenal tanpa kapabilitas apa pun: tidak ada flag yang ditempelkan.
  expect(r('custom', 'mycli')).toBe('mycli')
})

test('launchLine rejects a session id that is unsafe on a command line', () => {
  for (const bad of ['-evil', '.hidden', 'a b', 'a;rm -rf /', '$(id)', '']) {
    expect(launchLine(open({ cmd: 'claude', agentId: 'claude', sessionId: bad }), 9999)).toBe('claude')
  }
})

// --- Pembungkus perintah yang tidak terpasang --------------------------------------------------

test('unwrapMissingWrapper drops only wrappers that are absent', () => {
  const none = () => false
  const all = () => true
  const one = unwrapMissingWrapper('envman -e p -- claude', none)
  expect(one?.cmd).toBe('claude')
  expect(one?.missing).toBe('envman')
  // Pembungkus terpasang → tidak ada yang berubah.
  expect(unwrapMissingWrapper('envman -e p -- claude', all)).toBe(null)
  // Program utama yang hilang BUKAN pembungkus: biarkan shell melapor, jangan menebak.
  expect(unwrapMissingWrapper('claude --session-id x', none)).toBe(null)
  // Bersarang: yang dilaporkan adalah pembungkus terluar, yang dijalankan perintah terdalam.
  const nested = unwrapMissingWrapper('envman -e p -- wrap2 -- claude', none)
  expect(nested?.cmd).toBe('claude')
  expect(nested?.missing).toBe('envman')
  // Token pertama yang butuh interpretasi shell tidak pernah diutak-atik.
  expect(unwrapMissingWrapper('FOO=1 envman -e p -- claude', none)).toBe(null)
  expect(unwrapMissingWrapper('$(which envman) -e p -- claude', none)).toBe(null)
})

test('binaryExists finds a real binary and misses a fake one', () => {
  expect(binaryExists('/bin/sh')).toBe(true)
  expect(binaryExists('sh')).toBe(true)
  expect(binaryExists('webterm-definitely-not-a-binary-9f3a')).toBe(false)
  // Tidak pernah dicari di PATH kosong.
  expect(binaryExists('sh', '')).toBe(false)
})

test('a missing wrapper degrades to the bare command and says so once', async () => {
  const s = new Sessions()
  const a = collector()
  s.open(
    { t: 'open', id: 'w1', cols: 80, rows: 24, cmd: 'webterm-missing-wrapper-9f3a -e p -- echo WRAPPED_OK' },
    a.send
  )
  await pollFor(a.joined, 'WRAPPED_OK')
  expect(a.joined()).toContain('WRAPPED_OK')              // perintah polos benar-benar berjalan
  expect(a.joined()).toContain(`'webterm-missing-wrapper-9f3a' is not installed`)
  expect(a.joined().includes('load envman')).toBe(false)
  s.close('w1')
})

// --- Knob settings ------------------------------------------------------------------------------

test('shellArgv honours the shell parameter and falls back to the system default', () => {
  const argv = (...a: Parameters<typeof shellArgv>) => shellArgv(...a).join('\u0000')
  expect(argv('/bin/sh', 'echo hi')).toBe(['/bin/sh', '-l', '-c', 'echo hi'].join('\u0000'))
  expect(argv('/bin/sh')).toBe('/bin/sh')
  // Kosong / hanya spasi = default sistem, persis arti settings.defaultShell.
  const fallback = process.env.SHELL || 'bash'
  expect(argv('   ')).toBe(fallback)
  expect(argv(undefined, 'x')).toBe([fallback, '-l', '-c', 'x'].join('\u0000'))
})

test('a configured shell is the one that actually runs the command', async () => {
  const s = new Sessions({ shell: '/bin/sh' })
  const a = collector()
  s.open({ t: 'open', id: 'sh1', cols: 80, rows: 24, cmd: 'echo "ran_in:$0"' }, a.send)
  await pollFor(a.joined, 'ran_in:')
  expect(a.joined()).toContain('ran_in:/bin/sh')
  s.close('sh1')
})

test('the scrollback limit drops old output and keeps the newest', async () => {
  const s = new Sessions({ scrollbackBytes: 512 })
  const a = collector()
  s.open({ t: 'open', id: 'sb1', cols: 80, rows: 24 }, a.send)

  s.input('sb1', 'echo FIRST_MARKER_9f3a\n')
  await pollFor(() => s.getTerminal('sb1'), 'FIRST_MARKER_9f3a')
  expect(s.getTerminal('sb1')).toContain('FIRST_MARKER_9f3a')

  // Lebih dari 512 byte output sesudahnya harus mendorong marker pertama keluar ring buffer.
  s.input('sb1', 'for i in 1 2 3 4 5 6 7 8; do echo pad-$i-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; done\n')
  s.input('sb1', 'echo LAST_MARKER_9f3a\n')
  await pollFor(() => s.getTerminal('sb1'), 'LAST_MARKER_9f3a')

  const kept = s.getTerminal('sb1')
  expect(kept).toContain('LAST_MARKER_9f3a')
  expect(kept.includes('FIRST_MARKER_9f3a')).toBe(false)
  s.close('sb1')
})

test('an unusable scrollback setting falls back to the default instead of losing output', async () => {
  // Shell polos (tanpa cmd) supaya sesi tetap hidup: sesi yang keluar dihapus dari map, sehingga
  // getTerminal akan mengembalikan string kosong dan menguji hal yang salah.
  for (const bad of [0, -1, NaN, Number.POSITIVE_INFINITY]) {
    const s = new Sessions({ scrollbackBytes: bad })
    const a = collector()
    s.open({ t: 'open', id: 'sb2', cols: 80, rows: 24 }, a.send)
    s.input('sb2', 'echo KEEP_ME_9f3a\n')
    await pollFor(() => s.getTerminal('sb2'), 'KEEP_ME_9f3a')
    expect(s.getTerminal('sb2')).toContain('KEEP_ME_9f3a')
    s.close('sb2')
  }
})
