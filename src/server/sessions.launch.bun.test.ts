// Bun-only (imports the PTY module, which uses Bun.Terminal); runs under `bun test`, excluded from
// vitest. Pure launch-line assembly and shell/wrapper helpers: no PTY is spawned here. The PTY
// session behaviour lives in sessions.bun.test.ts.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `launchLine` for claude writes a real settings file: the whole file is isolated to a temp dir so
// the test never touches the user's data dir.
const DATA_DIR = mkdtempSync(join(tmpdir(), 'webterm-sessions-launch-'))
process.env.WEBTERM_DATA_DIR = DATA_DIR
// HOME is isolated too, as in sessions.bun.test.ts, so no helper reads the user's real home.
const ORIGINAL_HOME = process.env.HOME
process.env.HOME = DATA_DIR
// Restore HOME because every bun test file shares one process (`ptySpawn.bun.test.ts` reads it),
// and remove the temp dir so /tmp does not pile up one directory per run.
afterAll(() => {
  process.env.HOME = ORIGINAL_HOME
  rmSync(DATA_DIR, { recursive: true, force: true })
})

import type { OpenMsg } from '../shared/protocol'
import { launchLine } from './sessions'
import { binaryExists, shellArgv, unwrapMissingWrapper } from './pty'
import { resolveShell } from './ptyShell'
import { BUILTIN_AGENT_IDS, assembleCmd, setCustomAgentBaseResolver } from '../shared/workspace'
import { claudeNodeSettings, writeClaudeSettings } from './hooks'

// --- Perakitan baris peluncuran (murni, tanpa PTY) -------------------------------------------

const SID = '11111111-2222-3333-4444-555555555555'
const open = (over: Partial<OpenMsg>): OpenMsg =>
  ({ t: 'open', id: 'n1', cols: 80, rows: 24, ...over })

test('launchLine mints the session id with the claude grammar', () => {
  // claude: flag id spasi-terpisah PLUS path file hook --settings.
  const claude = launchLine(open({ cmd: 'claude', agentId: 'claude', sessionId: SID }), 9999)
  expect(claude).toContain(`--session-id ${SID}`)
  expect(claude).toContain('--settings ')
  expect(claude).toContain('node-settings/')
  // URL callback hidup di dalam file, bukan di argv (lihat regresi envman di hooks.test.ts).
  expect(claude).not.toContain('://')


  // Terminal biasa (tanpa agentId) dan agent tanpa session id: perintah apa adanya.
  expect(launchLine(open({ cmd: 'htop' }), 9999)).toBe('htop')
  expect(launchLine(open({ cmd: 'claude', agentId: 'claude' }), 9999)).toBe('claude')
  expect(launchLine(open({ agentId: 'claude', sessionId: SID }), 9999)).toBe(undefined)
})

test('no builtin launch command carries a wrapper webterm invented', () => {
  // Regresi dari bug nyata: `assembleCmd` dulu memancarkan `envman -e <profil> -- <agent>`, dan di
  // mesin tanpa envman SETIAP node agent mati dengan `load envman: no such file or directory`.
  // Perintah agent tidak boleh dibungkus sama sekali.
  for (const id of BUILTIN_AGENT_IDS) {
    const cmd = assembleCmd(id)
    expect(cmd).not.toContain('envman')
    expect(cmd).not.toContain(' -- ')
    // Yang diluncurkan harus program itu sendiri: token pertama = seluruh perintah.
    expect(cmd.split(' ')[0]).toBe(cmd)
    expect(launchLine(open({ cmd, agentId: id, sessionId: SID }), 9999)).not.toContain('envman')
  }

  // Override peluncuran milik pengguna menggantikan bagian program secara utuh — ini mekanisme
  // pemilihan akun/profil yang sebenarnya (`settings.agentLaunchCommands`).
  expect(assembleCmd('claude', 'claude-via-work-account')).toBe('claude-via-work-account')
  expect(assembleCmd('claude', '   ')).toBe('claude')
})

test('the claude hook flags are gated by capability, not by the agent id', () => {
  const flagged = (agentId: string) =>
    launchLine(open({ cmd: 'mycli', agentId, sessionId: SID }), 9999) ?? ''

  // Agent custom yang mewarisi harness claude IKUT dapat hook — binary-nya sendiri, flag claude.
  setCustomAgentBaseResolver((id) => (id === 'custom:proxy' ? 'claude' : undefined))
  try {
    const inherited = flagged('custom:proxy')
    expect(inherited).toContain('--settings ')
    expect(inherited).toContain(`--session-id ${SID}`)
    expect(inherited.startsWith('mycli ')).toBe(true)
    // Custom tanpa baseAgent tidak mewarisi apa pun: tidak ada flag yang ditempelkan.
    expect(flagged('custom:bare')).toBe('mycli')
  } finally {
    setCustomAgentBaseResolver(null)
  }

  // `--settings` adalah grammar claude. CLI lain TIDAK boleh menerimanya: flag yang tidak dikenal
  // membuat CLI-nya menolak di peluncuran, yaitu node mati.
  for (const id of ['codex', 'gemini', 'copilot']) {
    expect(launchLine(open({ cmd: id, agentId: id, sessionId: SID }), 9999)).not.toContain('--settings')
  }
})

test('launchLine sends the configured permission mode and nothing when unset', () => {
  const msg = open({ cmd: 'claude', agentId: 'claude', sessionId: SID })
  expect(launchLine(msg, 9999, { permissionMode: 'acceptEdits' })).toContain(
    '--permission-mode acceptEdits'
  )
  // `manual` is explicit (`default`): a bare launch starts in `auto` on current Claude Code.
  expect(launchLine(msg, 9999, { permissionMode: 'manual' })).toContain('--permission-mode default')
  expect(launchLine(msg, 9999, { permissionMode: 'auto' })).toContain('--permission-mode auto')
  expect(launchLine(msg, 9999)).not.toContain('--permission-mode')
})

test('launchLine resumes with the harness resume grammar', () => {
  const r = (agentId: string, cmd: string) =>
    launchLine(open({ cmd, agentId, sessionId: SID, resume: true }), 9999)
  expect(r('claude', 'claude')).toContain(`--resume ${SID}`)
  // Pembungkus tetap utuh: perintah client dipakai sebagai program secara keseluruhan.
  expect(r('claude', 'envman -e p -- claude')).toMatch(new RegExp(`^envman -e p -- claude .*--resume ${SID}`))
  // Agent tak dikenal tanpa kapabilitas apa pun: tidak ada flag yang ditempelkan.
  expect(r('custom', 'mycli')).toBe('mycli')
})

test('a custom agent with baseAgent claude keeps hooks, the launch profile grammar and resume', () => {
  setCustomAgentBaseResolver((id) => (id === 'custom:proxy' ? 'claude' : undefined))
  try {
    const fresh = launchLine(open({ cmd: 'my-claude-proxy', agentId: 'custom:proxy', sessionId: SID }), 9999) ?? ''
    expect(fresh.startsWith('my-claude-proxy ')).toBe(true)
    for (const flag of ['--settings ', `--session-id ${SID}`, '--mcp-config ']) expect(fresh).toContain(flag)
    const resumed = launchLine(open({ cmd: 'my-claude-proxy', agentId: 'custom:proxy', sessionId: SID, resume: true }), 9999) ?? ''
    expect(resumed).toContain(`--resume ${SID}`)
    expect(resumed).toContain('--settings ')
  } finally {
    setCustomAgentBaseResolver(null)
  }
})

test('a stored agentId:codex node launches its cmd with no flags added (fresh and resumed)', () => {
  // Claude-first migration: nodes are not converted; a retired builtin is a plain terminal program.
  for (const resume of [false, true]) {
    for (const [agentId, cmd] of [['codex', 'codex'], ['codex', 'envman -e p -- codex'], ['gemini', 'gemini'], ['cursor', 'cursor-agent'], ['antigravity', 'agy']]) {
      expect(launchLine(open({ cmd, agentId, sessionId: SID, resume }), 9999)).toBe(cmd)
    }
  }
})

test('launchLine mints the id again when the transcript it would resume is gone', () => {
  const msg = open({ cmd: 'claude', agentId: 'claude', sessionId: SID, resume: true })
  // Perilaku LAMA sebagai konstanta supaya guard ini terbukti menggigit: tanpa probe, `resume: true`
  // selalu memancarkan `--resume <sid>` — dan itulah yang membunuh node dengan "No conversation
  // found with session ID: <uuid>" ketika transcript-nya sudah hilang.
  const OLD_ALWAYS_RESUMES = `--resume ${SID}`
  expect(launchLine(msg, 9999)).toContain(OLD_ALWAYS_RESUMES)

  // Keputusan "transcript mati" disalurkan lewat opts — `launchLine` tetap murni, probe-nya milik
  // `open()` (lihat transcriptPresence.ts). webterm mencetak ULANG id-nya, tidak meluncur polos:
  // id itu milik webterm, jadi rantai resume node tetap utuh.
  const dead = launchLine(msg, 9999, { resumeIsDead: true }) ?? ''
  expect(dead).toContain(`--session-id ${SID}`)
  expect(dead.includes('--resume')).toBe(false)
  // Dan flag claude lainnya tidak ikut hilang: cabang ini jalur peluncuran yang sudah ada.
  expect(dead).toContain('--settings ')

  // `resumeIsDead: false` harus identik byte demi byte dengan sebelum modul ini ada.
  expect(launchLine(msg, 9999, { resumeIsDead: false })).toBe(launchLine(msg, 9999))
})

test('writeClaudeSettings lands the hook object in a file whose path has no colon', () => {
  const path = writeClaudeSettings('n-file', 9999)
  // Lewat JSON.parse → stringify: membuktikan file itu JSON sah DAN isinya objek hook yang sama.
  expect(JSON.stringify(JSON.parse(readFileSync(path, 'utf8')))).toBe(
    JSON.stringify(claudeNodeSettings('n-file', 9999))
  )
  // `:` adalah pemicu salah-tafsir pembungkus pihak ketiga (envman `slug:path`) — tidak boleh ada.
  expect(path).not.toContain(':')
  // Nama file di-hash, bukan node id mentah: id datang dari client dan bisa berisi `../`.
  expect(path).not.toContain('n-file')
  expect(writeClaudeSettings('n-file', 9999)).toBe(path)
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

// --- Knob settings ------------------------------------------------------------------------------

test('shellArgv honours the shell parameter and falls back to the system default', () => {
  const argv = (...a: Parameters<typeof shellArgv>) => shellArgv(...a).join('\u0000')
  expect(argv('/bin/sh', 'echo hi')).toBe(['/bin/sh', '-l', '-c', 'echo hi'].join('\u0000'))
  // Shell biasa = login shell, seperti Terminal.app.
  expect(argv('/bin/sh')).toBe(['/bin/sh', '-l'].join('\u0000'))
  // Kosong / hanya spasi = default sistem, persis arti settings.defaultShell.
  expect(argv('   ')).toBe(argv(undefined))
  expect(argv(undefined, 'x')).toBe([resolveShell(undefined), '-l', '-c', 'x'].join('\u0000'))
})
