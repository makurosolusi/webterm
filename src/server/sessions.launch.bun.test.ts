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
import { codexInstructionsFlag, tomlString } from './webtermAwareness'
import { shq } from './hooksQuote'
import { codexMcpFlags } from './mcp/mcp.launch'
import { binaryExists, shellArgv, unwrapMissingWrapper } from './pty'
import { resolveShell } from './ptyShell'
import { BUILTIN_AGENT_IDS, assembleCmd, setCustomAgentBaseResolver } from '../shared/workspace'
import { claudeNodeSettings, writeClaudeSettings } from './hooks'

// --- Perakitan baris peluncuran (murni, tanpa PTY) -------------------------------------------

const SID = '11111111-2222-3333-4444-555555555555'
/** Flag aturan rumah codex untuk node `n1`, dihitung lewat fungsi produksi (isinya diuji terpisah). */
const CODEX_N1 = codexInstructionsFlag('n1')

test('codex developer_instructions is one colon-free, TOML-escaped, shell-quoted argument', () => {
  expect(CODEX_N1.startsWith(`-c 'developer_instructions="You are running inside webterm`)).toBe(true)
  // envman memindai argv untuk `slug:path`: tidak boleh ada `:` sama sekali, juga dari id pane.
  const pane = codexInstructionsFlag('n1:p2')
  expect(pane).not.toContain(':')
  expect(pane).toContain('agent node n1.p2.')
  expect(CODEX_N1).toContain('IS the explicit permission of the user to drive that browser')
  expect(CODEX_N1.length < 1500).toBe(true)
  // TOML basic string: kutip, backslash, kontrol, dan DEL di-escape; hasilnya terbaca kembali utuh.
  const nasty = 'a"b\\c\nd\u007fe\u0001'
  const t = tomlString(nasty)
  expect(t).toBe('"a\\"b\\\\c\\nd\\u007Fe\\u0001"')
  expect(JSON.parse(t)).toBe(nasty)
  // Kutip tunggal di teks tidak bisa menutup quoting shell.
  expect(shq(`developer_instructions=${tomlString("it's")}`)).toBe(`'developer_instructions="it'\\''s"'`)
})
const open = (over: Partial<OpenMsg>): OpenMsg =>
  ({ t: 'open', id: 'n1', cols: 80, rows: 24, ...over })

test('launchLine mints the session id with each harness own grammar', () => {
  // claude: flag id spasi-terpisah PLUS path file hook --settings.
  const claude = launchLine(open({ cmd: 'claude', agentId: 'claude', sessionId: SID }), 9999)
  expect(claude).toContain(`--session-id ${SID}`)
  expect(claude).toContain('--settings ')
  expect(claude).toContain('node-settings/')
  // URL callback hidup di dalam file, bukan di argv (lihat regresi envman di hooks.test.ts).
  expect(claude).not.toContain('://')

  // copilot: bentuk `=`, dan TIDAK mengerti --settings.
  const copilot = launchLine(open({ cmd: 'copilot', agentId: 'copilot', sessionId: SID }), 9999)
  expect(copilot).toBe(`copilot --session-id=${SID}`)

  // cursor: tak punya flag session-id sama sekali — ia mengadopsi id lewat --resume <id baru>.
  const cursor = launchLine(open({ cmd: 'cursor-agent', agentId: 'cursor', sessionId: SID }), 9999)
  expect(cursor).toBe(`cursor-agent --resume ${SID}`)

  // codex & gemini resumable tapi BUKAN session-id-capable: tanpa flag session id. gemini tetap
  // identik byte demi byte; codex hanya mendapat `-c developer_instructions` (aturan rumah webterm)
  // dan `-c mcp_servers.webterm.*` (server MCP webterm).
  expect(launchLine(open({ cmd: 'gemini', agentId: 'gemini', sessionId: SID }), 9999)).toBe('gemini')
  expect(launchLine(open({ cmd: 'codex', agentId: 'codex', sessionId: SID }), 9999)).toBe(`codex ${CODEX_N1} ${codexMcpFlags('n1', 9999)}`)

  // Terminal biasa (tanpa agentId) dan agent tanpa session id: perintah apa adanya.
  expect(launchLine(open({ cmd: 'htop' }), 9999)).toBe('htop')
  expect(launchLine(open({ cmd: 'claude', agentId: 'claude' }), 9999)).toBe('claude')
  expect(launchLine(open({ agentId: 'claude', sessionId: SID }), 9999)).toBe(undefined)
})

test('no builtin launch command carries a wrapper webterm invented', () => {
  // Regresi dari bug nyata: `assembleCmd` dulu memancarkan `envman -e <profil> -- <agent>`, dan di
  // mesin tanpa envman SETIAP node agent mati dengan `load envman: no such file or directory`.
  // nodeterm tidak membungkus perintah agent sama sekali, jadi webterm juga tidak boleh.
  for (const id of BUILTIN_AGENT_IDS) {
    const cmd = assembleCmd(id)
    expect(cmd).not.toContain('envman')
    expect(cmd).not.toContain(' -- ')
    // Yang diluncurkan harus program itu sendiri: token pertama = seluruh perintah.
    expect(cmd.split(' ')[0]).toBe(cmd)
    expect(launchLine(open({ cmd, agentId: id, sessionId: SID }), 9999)).not.toContain('envman')
  }

  // Override peluncuran milik pengguna menggantikan bagian program secara utuh — ini mekanisme
  // pemilihan akun/profil yang sebenarnya (`settings.agentLaunchCommands`), seperti di nodeterm.
  expect(assembleCmd('claude', 'claude-via-work-account')).toBe('claude-via-work-account')
  expect(assembleCmd('codex', '   ')).toBe('codex')
  expect(assembleCmd('antigravity', undefined)).toBe('agy')
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

  // `--settings` adalah grammar claude. Builtin lain TIDAK boleh menerimanya: flag yang tidak
  // dikenal membuat CLI-nya menolak di peluncuran, yaitu node mati.
  for (const id of BUILTIN_AGENT_IDS.filter((a) => a !== 'claude')) {
    expect(launchLine(open({ cmd: id, agentId: id, sessionId: SID }), 9999)).not.toContain('--settings')
  }
})

test('launchLine sends the configured permission mode and nothing when unset', () => {
  const msg = open({ cmd: 'claude', agentId: 'claude', sessionId: SID })
  expect(launchLine(msg, 9999, { permissionMode: 'acceptEdits' })).toContain(
    '--permission-mode acceptEdits'
  )
  // `manual` dan "belum disambungkan" sama-sama berarti perintah polos — tanpa flag.
  expect(launchLine(msg, 9999, { permissionMode: 'manual' })).not.toContain('--permission-mode')
  expect(launchLine(msg, 9999)).not.toContain('--permission-mode')
})

test('launchLine resumes with the harness resume grammar', () => {
  const r = (agentId: string, cmd: string) =>
    launchLine(open({ cmd, agentId, sessionId: SID, resume: true }), 9999)
  expect(r('claude', 'claude')).toContain(`--resume ${SID}`)
  expect(r('codex', 'codex')).toBe(`codex ${CODEX_N1} ${codexMcpFlags('n1', 9999)} resume ${SID}`)
  expect(r('copilot', 'copilot')).toBe(`copilot --resume=${SID}`)
  expect(r('antigravity', 'agy')).toBe(`agy --conversation=${SID}`)
  // Pembungkus tetap utuh: perintah client dipakai sebagai program secara keseluruhan.
  expect(r('codex', 'envman -e p -- codex')).toBe(`envman -e p -- codex ${CODEX_N1} ${codexMcpFlags('n1', 9999)} resume ${SID}`)
  // Agent tak dikenal tanpa kapabilitas apa pun: tidak ada flag yang ditempelkan.
  expect(r('custom', 'mycli')).toBe('mycli')
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
