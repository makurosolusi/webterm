import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// `forgetNodeToken` menyapu file settings node, jadi ia menyentuh data dir. Diarahkan ke temp
// supaya test ini tidak pernah mengutak-atik data dir pengguna.
process.env.WEBTERM_DATA_DIR = join(tmpdir(), 'webterm-hooks-test')

import type { AgentPermissionMode } from '../shared/workspace'
import { isSafeNodeId } from '../shared/workspace'
import { TOKEN_HEADER } from './auth'
import {
  CLAUDE_HOOK_EVENTS,
  NODE_HEADERS_ENV,
  NODE_TOKEN_ENV,
  NODE_TOKEN_HEADER,
  PERMISSION_REQUEST_HOOK_TIMEOUT_SECS,
  PERM_WAIT_SECS_INTERACTIVE,
  buildClaudeFlags,
  claudeHooksSettings,
  forgetNodeToken,
  hookEnv,
  hookEventName,
  isValidNodeToken,
  nodeIdForToken,
  nodeToken,
  permissionModeFlag,
  stateVerified,
  writeClaudeSettings,
} from './hooks'
import { nextHookContext } from './hookContext'
import { claudeHeadersPath } from './hooksPaths'

/** Baris curl yang dibangun untuk satu node, diambil dari event `Stop` (semua event memakai baris
 *  yang sama persis — lihat test "subscribes the 11 nodeterm events"). */
function commandFor(nodeId: string): string {
  const hooks = claudeHooksSettings(nodeId, 8700).hooks as Record<string, unknown[]>
  return (hooks['Stop'][0] as { hooks: { command: string }[] }).hooks[0].command
}

/** Path file header yang ditunjuk `-H @'<path>'` di baris hook. */
function headersPathOf(cmd: string): string {
  const m = /-H @'([^']+)'/.exec(cmd)
  if (!m) throw new Error(`no @header file in command: ${cmd}`)
  return m[1]
}

describe('claudeHooksSettings', () => {
  it('subscribes the 11 nodeterm events, each with a node-keyed command', () => {
    const hooks = claudeHooksSettings('n1', 8700).hooks as Record<string, unknown[]>
    expect(Object.keys(hooks)).toHaveLength(11)
    expect(Object.keys(hooks)).toEqual(CLAUDE_HOOK_EVENTS.map(hookEventName))
    for (const key of Object.keys(hooks)) {
      const entry = hooks[key][0] as { hooks: { command: string }[] }
      expect(entry.hooks[0].command).toContain('node=n1')
      expect(entry.hooks[0].command).toContain('127.0.0.1:8700')
    }
  })
  it('declares the hold timeout on PermissionRequest only', () => {
    const hooks = claudeHooksSettings('n1', 8700).hooks as Record<string, unknown[]>
    const timeoutOf = (k: string): number | undefined =>
      (hooks[k][0] as { hooks: { timeout?: number }[] }).hooks[0].timeout
    expect(timeoutOf('PermissionRequest')).toBe(PERMISSION_REQUEST_HOOK_TIMEOUT_SECS)
    for (const k of Object.keys(hooks)) if (k !== 'PermissionRequest') expect(timeoutOf(k)).toBeUndefined()
  })
  it('leaves the hold timeout above the wait it bounds', () => {
    expect(PERMISSION_REQUEST_HOOK_TIMEOUT_SECS).toBeGreaterThan(PERM_WAIT_SECS_INTERACTIVE)
  })
  it('never puts a token value or env reference on the command line', () => {
    const tok = nodeToken('n-ref')
    const cmd = commandFor('n-ref')
    // `-H @file`: nilainya dibaca curl dari file 0600, tidak pernah menjadi argv.
    expect(cmd).toContain(`-H @'`)
    expect(cmd).toContain('.headers')
    expect(cmd).not.toContain(tok)
    // Referensi env var pun sudah tidak ada lagi — shell meng-expand-nya SEBELUM exec, jadi token
    // aslinya tetap mendarat di argv.
    expect(cmd).not.toContain(`$${NODE_TOKEN_ENV}`)
    expect(cmd).not.toContain('$WEBTERM_TOKEN')
  })
  it('points at a single header file that carries both headers', () => {
    // Seluruh `/api/` digerbangi `authorize()` lewat `x-webterm-token`, jadi hook butuh KEDUA
    // header. Keduanya hidup di file yang sama; nama env var ditulis literal di test supaya ejaan
    // yang berubah di hooks.ts menggagalkan test ini.
    const cmd = commandFor('n-transport')
    expect(headersPathOf(cmd)).toMatch(/\.headers$/)
    expect(cmd.match(/-H /g)).toHaveLength(1)
  })
  it('builds a line sh can parse', () => {
    execFileSync('sh', ['-n'], { input: commandFor('n-syntax') })
  })
})

// -----------------------------------------------------------------------------------------------
// Redirect baris hook. Stdout hook adalah kanal masuk ke konteks agent, jadi ia TIDAK boleh dibuang;
// stderr curl justru harus dibungkam sendiri, karena di stdout ia jadi teks sampah di konteks agent.

/** Ada redirect stdout ke /dev/null? Redirect stderr disingkirkan dulu: `2>/dev/null` memuat
 *  `>/dev/null` sebagai substring, jadi pencocokan naif akan selalu "menemukan" stdout dibuang. */
const dropsStdout = (cmd: string) => />\s*\/dev\/null/.test(cmd.replace(/2>\s*\/dev\/null/g, ''))
const silencesStderr = (cmd: string) => /2>\s*\/dev\/null/.test(cmd) && !/2>&1/.test(cmd)
const survivesFailure = (cmd: string) => /\|\|\s*true/.test(cmd)

/** Bentuk LAMA, persis seperti sebelum kanalnya dibuka. Dipakai untuk membuktikan guard di atas
 *  benar-benar menggigit, bukan lulus karena polanya mustahil ditemukan. */
const OLD_CMD =
  `curl -s 'http://127.0.0.1:8700/api/agent-status?node=n1' ` +
  `-H "${NODE_TOKEN_HEADER}: $${NODE_TOKEN_ENV}" -H "${TOKEN_HEADER}: $WEBTERM_TOKEN" ` +
  `--data-binary @- >/dev/null 2>&1 || true`

describe('redirect baris hook', () => {
  it('tidak lagi membuang stdout — di situlah balasan konteks agent lewat', () => {
    expect(dropsStdout(commandFor('n-stdout'))).toBe(false)
  })

  it('membungkam stderr SENDIRI, tidak menggabungnya ke stdout', () => {
    const cmd = commandFor('n-stderr')
    expect(silencesStderr(cmd)).toBe(true)
    // Dipaku terpisah: `2>&1` yang kembali mengirim pesan gagal-konek curl ke konteks agent.
    expect(cmd).not.toContain('2>&1')
  })

  it('tetap `|| true` — hook yang gagal tidak boleh menggagalkan turn agent', () => {
    expect(survivesFailure(commandFor('n-fail'))).toBe(true)
  })

  it('ketiga guard menolak bentuk lamanya', () => {
    expect(dropsStdout(OLD_CMD)).toBe(true)
    expect(silencesStderr(OLD_CMD)).toBe(false)
    // Dan melewatkan bentuk yang benar, supaya bukan guard yang selalu merah.
    expect(dropsStdout('curl -s x --data-binary @- 2>/dev/null || true')).toBe(false)
    expect(silencesStderr('curl -s x --data-binary @- 2>/dev/null || true')).toBe(true)
    expect(survivesFailure(OLD_CMD)).toBe(true)
    expect(survivesFailure('curl -s x --data-binary @- 2>/dev/null')).toBe(false)
  })
})

// -----------------------------------------------------------------------------------------------
// Apa yang BENAR-BENAR diterima curl. Bentuk string saja tidak membuktikan apa pun, jadi `curl`
// di-stub lewat shim di PATH yang mencatat argv-nya, lalu barisnya dijalankan `sh` sungguhan.

/** Token palsu yang sengaja memuat spasi, `$`, dan kutip tunggal — tiga hal yang hancur duluan
 *  kalau ekspansinya tak terkutip atau ter-word-split. BUKAN dibaca dari environment. */
const FAKE_TRANSPORT_TOKEN = `fa ke$it's`
const FAKE_NODE_TOKEN = 'not-a-real-node-token'

/** Jalankan baris hook dengan `curl` yang di-stub; kembalikan argv yang diterima stub itu. */
function curlArgv(cmd: string, env: Record<string, string>): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'webterm-curl-shim-'))
  try {
    const out = join(dir, 'argv')
    writeFileSync(join(dir, 'curl'), '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a" >> "$ARGV_OUT"; done\n', {
      mode: 0o755,
    })
    // Interpreter-nya absolut justru supaya `PATH` boleh memuat shim SAJA: dengan begitu `curl`
    // di baris itu tidak mungkin me-resolve ke curl sungguhan (yang akan mem-POST ke dev server
    // kalau ada yang berjalan di port 8700).
    // `</dev/null`: baris itu memuat `--data-binary @-`, dan tanpa ini stub-nya menggantung
    // menunggu stdin milik test runner.
    execFileSync('/bin/sh', ['-c', `${cmd} </dev/null`], {
      env: { PATH: dir, ARGV_OUT: out, ...env },
    })
    return readFileSync(out, 'utf8').split('\n').slice(0, -1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('the argv curl actually receives', () => {
  it('never carries a token value, only the path to the header file', () => {
    const argv = curlArgv(commandFor('n-argv'), {
      WEBTERM_TOKEN: FAKE_TRANSPORT_TOKEN,
      [NODE_TOKEN_ENV]: FAKE_NODE_TOKEN,
    })
    // Inilah gunanya file header: `ps` hanya melihat path-nya, bukan nilai token.
    const joined = argv.join('\n')
    expect(joined).not.toContain(FAKE_TRANSPORT_TOKEN)
    expect(joined).not.toContain(FAKE_NODE_TOKEN)
    expect(joined).not.toContain(TOKEN_HEADER)
    expect(joined).not.toContain(NODE_TOKEN_HEADER)
    // Dan path itu memang datang sebagai argumen `-H`.
    const headerArg = argv[argv.indexOf('-H') + 1]
    expect(headerArg.startsWith('@')).toBe(true)
    expect(headerArg.endsWith('.headers')).toBe(true)
  })
  it('stays well-formed with exactly one -H, even when no transport token is configured', () => {
    const argv = curlArgv(commandFor('n-argv-empty'), { [NODE_TOKEN_ENV]: FAKE_NODE_TOKEN })
    expect(argv).toContain('--data-binary')
    expect(argv.filter((a) => a === '-H')).toHaveLength(1)
    expect(argv[argv.indexOf('-H') + 1]).toMatch(/^@.*\.headers$/)
  })
})

// -----------------------------------------------------------------------------------------------
// File header. Ini yang sekarang memikul token, jadi izin dan siklus hidupnya ikut diuji.

describe('hook header file', () => {
  it('is 0600, carries the node token for both headers, and is what the command points at', () => {
    const settingsPath = writeClaudeSettings('n-headers', 8700)
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    const cmd = settings.hooks.Stop[0].hooks[0].command
    const headersPath = headersPathOf(cmd)
    const token = nodeToken('n-headers')

    expect(statSync(headersPath).mode & 0o777).toBe(0o600)
    const content = readFileSync(headersPath, 'utf8')
    expect(content).toContain(`${NODE_TOKEN_HEADER}: ${token}`)
    expect(content).toContain(`${TOKEN_HEADER}: ${token}`)

    // Settings JSON sendiri tidak memuat nilai token apa pun.
    const raw = readFileSync(settingsPath, 'utf8')
    expect(raw).not.toContain(token)
  })

  it('never writes the root transport token, even when one is configured', () => {
    const prev = process.env.WEBTERM_TOKEN
    process.env.WEBTERM_TOKEN = FAKE_TRANSPORT_TOKEN
    try {
      const cmd = commandFor('n-headers-root')
      writeClaudeSettings('n-headers-root', 8700)
      const content = readFileSync(headersPathOf(cmd), 'utf8')
      expect(content).not.toContain(FAKE_TRANSPORT_TOKEN)
      expect(content).toContain(`${TOKEN_HEADER}: ${nodeToken('n-headers-root')}`)
    } finally {
      if (prev === undefined) delete process.env.WEBTERM_TOKEN
      else process.env.WEBTERM_TOKEN = prev
    }
  })

  it('is deleted with the node, alongside the settings file', () => {
    const settingsPath = writeClaudeSettings('n-headers-gone', 8700)
    const headersPath = headersPathOf(commandFor('n-headers-gone'))
    expect(statSync(headersPath).isFile()).toBe(true)

    forgetNodeToken('n-headers-gone')

    expect(() => statSync(headersPath)).toThrow()
    expect(() => statSync(settingsPath)).toThrow()
  })
})

describe('node id di baris hook', () => {
  it('memakai id apa adanya untuk id yang aman, dan tetap satu argumen URL', () => {
    const argv = curlArgv(commandFor('t1'), { [NODE_TOKEN_ENV]: FAKE_NODE_TOKEN })
    expect(argv[1]).toBe('http://127.0.0.1:8700/api/agent-status?node=t1')
    expect(commandFor('cl7')).toContain('node=cl7')
  })

  // Meski `isSafeNodeId` menolak id ini di batas WebSocket, `claudeHooksSettings` harus tetap benar
  // sendirian: ia bisa dipanggil dari jalur lain, dan satu lapis validasi saja bukan pertahanan.
  const INJECTIONS = [
    `n1'; rm -rf / #`,
    'n1$(touch /tmp/pwn)',
    'n1`id`',
    'n1 a b',
    'n1\nwhoami',
    'n1&x-window=1',
    'n1"quoted"',
  ]

  it('tidak pernah meneruskan metakarakter ke shell', () => {
    for (const id of INJECTIONS) {
      const cmd = commandFor(id)
      // Shell sungguhan harus menerimanya sebagai sintaks yang sah.
      execFileSync('sh', ['-n'], { input: cmd })
      // Dan yang benar-benar diterima curl: SATU argumen URL, yang id-nya masih utuh saat di-decode
      // — itu bukti id-nya sampai ke server, bukan cuma "tidak meledak".
      const argv = curlArgv(cmd, { [NODE_TOKEN_ENV]: FAKE_NODE_TOKEN })
      expect(argv.filter((a) => a.startsWith('http://'))).toHaveLength(1)
      expect(new URL(argv[1]).searchParams.get('node')).toBe(id)
      // Tidak ada pecahan mentah yang lolos sebagai argumen tersendiri.
      expect(argv).not.toContain('rm')
      expect(argv).not.toContain('-rf')
      expect(argv).not.toContain('touch')
      expect(argv).not.toContain('/tmp/pwn')
      expect(argv).not.toContain('whoami')
    }
  })

  it('URL tetap satu blok kutip tunggal, tanpa id mentah di dalamnya', () => {
    const cmd = commandFor(`n1'; touch /tmp/x; '`)
    // Kutip id tidak boleh menutup kutip milik URL: satu-satunya `'` di baris itu adalah pembuka
    // dan penutup argumen URL (dua), jadi kutip id wajib sudah ter-encode.
    expect(cmd).not.toContain(`node=n1';`)
    expect(cmd).toContain("curl -s 'http://127.0.0.1:8700/api/agent-status?node=n1%27")
  })
})

describe('node token', () => {
  it('mints one stable token per node', () => {
    const a = nodeToken('n-a')
    expect(nodeToken('n-a')).toBe(a)
    expect(nodeToken('n-b')).not.toBe(a)
  })
  it('verifies a matching token and rejects everything else', () => {
    const tok = nodeToken('n-v')
    expect(stateVerified('n-v', tok)).toBe(true)
    expect(stateVerified('n-v', [tok])).toBe(true)
    expect(stateVerified('n-v', `${tok}x`)).toBe(false)
    expect(stateVerified('n-v', undefined)).toBe(false)
    expect(stateVerified('n-v', '')).toBe(false)
  })
  it('reports unverified for a node that has no token', () => {
    nodeToken('n-gone')
    forgetNodeToken('n-gone')
    expect(stateVerified('n-gone', 'anything')).toBe(false)
  })
  it('sweeps the hook-context memo too, so a reused id is announced again', () => {
    // Memo pengumuman roster hidup per node di memori proses. Dibuktikan lewat perilaku, bukan mock:
    // umumkan sekali, pastikan turn kedua senyap (dedup bekerja), lupakan node, lalu turn ketiga
    // harus berbunyi lagi. Tanpa `forgetHookContext` di `forgetNodeToken`, turn ketiga tetap senyap.
    const doc = { links: [{ id: 'peer-1', title: 'agent berita' }] }
    expect(nextHookContext('n-memo', 'UserPromptSubmit', doc)).not.toBeNull()
    expect(nextHookContext('n-memo', 'UserPromptSubmit', doc)).toBeNull()
    forgetNodeToken('n-memo')
    expect(nextHookContext('n-memo', 'UserPromptSubmit', doc)).not.toBeNull()
  })
})

describe('hookEnv', () => {
  it('carries the PATH of the node header file, never the token value (env is readable by sibling processes)', () => {
    const env = hookEnv('n-env')
    expect(env[NODE_HEADERS_ENV]).toBe(claudeHeadersPath('n-env'))
    expect(env).not.toHaveProperty(NODE_TOKEN_ENV)
    expect(Object.values(env)).not.toContain(nodeToken('n-env'))
  })
  it('injects only the header path, whatever hookReplyApprovals says (the hold lives in the hook, not env)', () => {
    const expected = { [NODE_HEADERS_ENV]: claudeHeadersPath('n-env') }
    expect(hookEnv('n-env', { hookReplyApprovals: true })).toEqual(expected)
    expect(hookEnv('n-env', { hookReplyApprovals: false })).toEqual(expected)
    expect(hookEnv('n-env')).toEqual(expected)
  })
})

describe('permissionModeFlag', () => {
  it('emits the flag for a real mode', () => {
    expect(permissionModeFlag('plan')).toBe('--permission-mode plan')
    expect(permissionModeFlag('bypassPermissions')).toBe('--permission-mode bypassPermissions')
  })
  it('emits nothing for manual, undefined or an unrecognized value', () => {
    expect(permissionModeFlag('manual')).toBe('')
    expect(permissionModeFlag(undefined)).toBe('')
    // Settings bisa diedit tangan — nilai asing tidak boleh mendarat di baris perintah.
    expect(permissionModeFlag('; rm -rf /' as never)).toBe('')
  })
})

describe('buildClaudeFlags', () => {
  // Penulis settings di-stub: test ini harus tetap bebas I/O.
  const writeSettings = () => '/tmp/x.json'
  const writeRules = () => '/tmp/rules.md'
  const writeMcp = () => '/tmp/x.mcp.json'
  const flags = (resume: boolean, permissionMode?: AgentPermissionMode) =>
    buildClaudeFlags('n1', 'uuid-x', 8700, resume, { permissionMode, writeSettings, writeRules, writeMcp })

  it('adds the webterm MCP server config as the LAST flag (--mcp-config is variadic)', () => {
    expect(flags(false).endsWith("--mcp-config '/tmp/x.mcp.json'")).toBe(true)
    expect(flags(true).endsWith("--mcp-config '/tmp/x.mcp.json'")).toBe(true)
  })

  it('appends the webterm house rules file to the system prompt, fresh and resumed', () => {
    expect(flags(false)).toContain("--append-system-prompt-file '/tmp/rules.md'")
    expect(flags(true)).toContain("--append-system-prompt-file '/tmp/rules.md'")
  })

  it('uses --session-id for a fresh session', () => {
    const f = flags(false)
    expect(f).toContain('--session-id uuid-x')
    expect(f).toContain("--settings '/tmp/x.json'")
  })
  it('uses --resume when resuming, not --session-id', () => {
    const f = flags(true)
    expect(f).toContain('--resume uuid-x')
    expect(f).not.toContain('--session-id')
  })
  it('emits --permission-mode when one is passed in', () => {
    expect(flags(false, 'acceptEdits')).toContain('--permission-mode acceptEdits')
  })
  it('stays byte-identical to the bare line for manual mode', () => {
    expect(flags(false, 'manual')).toBe(flags(false))
  })
  it('never puts a URL on the command line (regression: envman 404 on `http:`)', () => {
    // Blob JSON inline membawa URL callback hook ke argv; pembungkus seperti envman memindai tiap
    // argumen untuk pola referensi `slug:path`, membaca `http://127.0.0.1:...` sebagai project
    // bernama `http`, lalu keluar 404 — claude tidak pernah dieksekusi. Path tidak punya `:`.
    const f = flags(false)
    expect(f).not.toContain('://')
    expect(f).not.toContain('127.0.0.1')
    expect(f).toContain('/tmp/x.json')
  })
})

// -----------------------------------------------------------------------------------------------
// Bentuk route `POST /api/agent-status`. Ia butuh `./db` (bun:sqlite) dan sebuah
// IncomingMessage/ServerResponse nyata, jadi tidak bisa diimpor atau dijalankan di suite node-env
// ini. Yang bisa: membaca source modul route-nya dan menolak bentuk yang salah — pola yang sama
// dengan `src/client/workspaceCommit.test.ts`. Sejak blok route dipindah ke `agentStatusApi.ts`,
// yang di-slice adalah badan `agentStatusRoute` di sana; `api.ts` hanya menyisakan satu baris
// dispatch, dan itu pun diuji (lihat "api.ts hanya men-dispatch").
const apiSrc = () => readFileSync(fileURLToPath(new URL('./api.ts', import.meta.url)), 'utf8')
const agentStatusSrc = () =>
  readFileSync(fileURLToPath(new URL('./agentStatusApi.ts', import.meta.url)), 'utf8')
const contextLinkSrc = () =>
  readFileSync(fileURLToPath(new URL('./contextLinkApi.ts', import.meta.url)), 'utf8')

/** Badan `agentStatusRoute` saja: mulai dari deklarasinya sampai akhir file modul route. */
const agentStatusBlock = (s: string) => s.split('export async function agentStatusRoute')[1] ?? ''

/** Badan `contextLinkRoute` saja, dari deklarasi sampai akhir modul route. */
const contextLinkBlock = (s: string) => s.split('export async function contextLinkRoute')[1] ?? ''

/** Route-nya MEMBALAS payload hook, dan tetap punya jalur 204 untuk `null`. */
const repliesWithHookPayload = (b: string) =>
  /nextHookContext\(/.test(b) && /hookSpecificOutput/.test(b) && /res\.statusCode = 204/.test(b)

/** Badge status + registrasi transcript dijalankan DULU: itu jalur yang sudah ada, dan ia tidak
 *  boleh bergantung pada apakah ada pengumuman konteks untuk dikirim. */
const statusPathRunsFirst = (b: string) =>
  b.includes('setStatus') &&
  b.includes('setTranscript') &&
  b.indexOf('setTranscript') < b.indexOf('nextHookContext')

// Bentuk LAMA route-nya, persis seperti sebelum balasannya diisi — membuktikan guard menggigit.
const OLD_ROUTE = `
    const status = node ? hookStatus(body) : null
    if (node && status) sessions.setStatus(node, status)
    if (node && typeof body.transcript_path === 'string') sessions.setTranscript(node, body.transcript_path)
    res.statusCode = 204; res.end(); return`

describe('route POST /api/agent-status', () => {
  it('membalas payload hook, dan masih punya jalur 204 saat tidak ada payload', () => {
    const b = agentStatusBlock(agentStatusSrc())
    // Dihitung dulu: blok kosong akan meluluskan guard apa pun tanpa menjaga apa-apa.
    expect(b.length).toBeGreaterThan(0)
    expect(repliesWithHookPayload(b)).toBe(true)
    // 204 tetap TANPA body — `json(res, 204)` pun akan tetap body-less, tapi jalur lamanya dijaga
    // apa adanya supaya kontrak 204-nya tidak bergeser diam-diam.
    expect(b).toContain('res.statusCode = 204; res.end(); return')
  })

  it('menjalankan jalur status/transcript sebelum menghitung pengumuman', () => {
    expect(statusPathRunsFirst(agentStatusBlock(agentStatusSrc()))).toBe(true)
  })

  it('tidak menduplikasi keputusan event di route — itu milik hookContext', () => {
    // `nextHookContext` sendiri yang memutuskan event mana layak diumumkan. Menyalin daftarnya ke
    // sini berarti dua tempat harus berubah bersamaan, dan yang satu akan tertinggal.
    const b = agentStatusBlock(agentStatusSrc())
    expect(b).not.toContain('SessionStart')
    expect(b).not.toContain("'UserPromptSubmit'")
  })

  it('kedua guard menolak bentuk lama route-nya', () => {
    expect(repliesWithHookPayload(OLD_ROUTE)).toBe(false)
    expect(statusPathRunsFirst(OLD_ROUTE)).toBe(false)
  })

  it('api.ts hanya men-dispatch satu baris ke modul route', () => {
    const s = apiSrc()
    expect(s).toContain('await agentStatusRoute(req, res, url)')
    // Blok lamanya tidak boleh tersisa di api.ts — dua salinan guard/payload akan menyimpang.
    expect(s).not.toContain('hookSpecificOutput')
    expect(agentStatusBlock(agentStatusSrc())).toContain('/api/agent-status')
  })
})

// -----------------------------------------------------------------------------------------------
// B2 (security QC): route ini menulis status/transcript untuk `node` yang datang dari query string,
// jadi ia batas input ketiga setelah WebSocket. Karena `api.ts` tidak bisa dijalankan di suite
// node-env ini (butuh bun:sqlite + IncomingMessage nyata), guard-nya dibaca dari source — pola yang
// sama dengan blok di atas — sementara domain inputnya diuji langsung lewat `isSafeNodeId`.

/** Guard id ada di blok, dan dijalankan SEBELUM apa pun yang menulis state. */
const rejectsUnsafeNode = (b: string) =>
  /isSafeNodeId\(\s*node\s*\)/.test(b) && b.indexOf('isSafeNodeId') < b.indexOf('setStatus')

/** `transcript_path` hanya disimpan kalau panjangnya di bawah batas, dan tidak pernah dibaca. */
const boundsTranscriptPath = (b: string) =>
  /transcript_path\.length/.test(b) && /TRANSCRIPT_PATH_MAX/.test(b) && !/readFileSync/.test(b)

const NO_GUARD_ROUTE = OLD_ROUTE

describe('guard node id di route /api', () => {
  it('agent-status menolak node hilang/tidak aman sebagai no-op 204', () => {
    const b = agentStatusBlock(agentStatusSrc())
    expect(b.length).toBeGreaterThan(0)
    expect(rejectsUnsafeNode(b)).toBe(true)
    // No-op-nya berstatus 204 dan berhenti SEBELUM body dibaca/ditulis.
    expect(b).toMatch(/isSafeNodeId\(node\)\)\s*\{[^}]*res\.statusCode = 204; res\.end\(\); return/)
    // Bentuk lama (tanpa guard) harus DITOLAK oleh predikat yang sama.
    expect(rejectsUnsafeNode(NO_GUARD_ROUTE)).toBe(false)
  })

  it('agent-status membatasi panjang transcript_path dan tidak membacanya', () => {
    const b = agentStatusBlock(agentStatusSrc())
    expect(boundsTranscriptPath(b)).toBe(true)
    expect(boundsTranscriptPath(OLD_ROUTE)).toBe(false)
  })

  it('domain guard-nya benar-benar menolak nilai yang dipakai penyerang', () => {
    // Contoh dari laporan QC: traversal path dan id raksasa.
    expect(isSafeNodeId('../../etc/passwd')).toBe(false)
    expect(isSafeNodeId('a'.repeat(10_000))).toBe(false)
    expect(isSafeNodeId('node with space')).toBe(false)
    expect(isSafeNodeId('')).toBe(false)
    expect(isSafeNodeId(null)).toBe(false)
    // …dan tidak menolak id sah, supaya guard-nya bukan yang selalu merah.
    expect(isSafeNodeId('a1b2c3d4-0000-4000-8000-000000000000')).toBe(true)
  })

  it('context-link menolak node tidak aman dengan 400 sebelum render', () => {
    const b = contextLinkBlock(contextLinkSrc())
    expect(b.length).toBeGreaterThan(0)
    expect(/isSafeNodeId\(\s*nodeParam\s*\)/.test(b)).toBe(true)
    expect(b).toContain('sendJson(res, 400')
    // Dibandingkan dengan PEMANGGILAN-nya, bukan kata di komentar penjelas.
    expect(b.indexOf('isSafeNodeId')).toBeLessThan(b.indexOf('await renderForRequester('))
  })

  // HIGH: token node tadinya tidak terikat ke node mana pun — `?node=` bebas diganti.
  it('agent-status mengikat token node ke `?node` sebelum menulis state', () => {
    const b = agentStatusBlock(agentStatusSrc())
    expect(b.length).toBeGreaterThan(0)
    expect(b).toContain('nodeTokenMismatch(requesterNodeId(req), node)')
    expect(b).toContain('json(res, 403')
    // Ditolak sebelum ada satu pun penulisan registry (dibandingkan dengan PEMANGGILAN-nya, bukan
    // kata `setStatus` di komentar penjelas).
    expect(b.indexOf('nodeTokenMismatch')).toBeLessThan(b.indexOf('deps.setStatus'))
    expect(b.indexOf('nodeTokenMismatch')).toBeLessThan(b.indexOf('deps.setTranscript'))
  })

  it('context-link mengikat token node ke `?node` sebelum render', () => {
    const b = contextLinkBlock(contextLinkSrc())
    expect(b.length).toBeGreaterThan(0)
    expect(b).toContain('nodeTokenMismatch(requesterNodeId(req), requester)')
    expect(b).toContain('sendJson(res, 403')
    expect(b.indexOf('nodeTokenMismatch')).toBeLessThan(b.indexOf('await renderForRequester('))
  })
})

describe('isValidNodeToken', () => {
  it('accepts a minted node token and rejects everything else', () => {
    const tok = nodeToken('n-transport')
    expect(isValidNodeToken(tok)).toBe(true)
    expect(isValidNodeToken('nope')).toBe(false)
    expect(isValidNodeToken('')).toBe(false)
    expect(isValidNodeToken(tok.slice(0, -1))).toBe(false)
  })
  it('stops accepting a token once the node is forgotten', () => {
    const tok = nodeToken('n-transport-gone')
    expect(isValidNodeToken(tok)).toBe(true)
    forgetNodeToken('n-transport-gone')
    expect(isValidNodeToken(tok)).toBe(false)
  })
})

describe('nodeIdForToken', () => {
  it('maps a minted token back to its own node', () => {
    const a = nodeToken('n-owner-a')
    const b = nodeToken('n-owner-b')
    expect(nodeIdForToken(a)).toBe('n-owner-a')
    expect(nodeIdForToken(b)).toBe('n-owner-b')
    expect(a).not.toBe(b)
  })
  it('answers undefined for unknown/empty values, so a root token is not a node identity', () => {
    expect(nodeIdForToken('root-or-foreign-token')).toBeUndefined()
    expect(nodeIdForToken('')).toBeUndefined()
  })
  it('drops the reverse binding when the node is forgotten', () => {
    const tok = nodeToken('n-owner-gone')
    expect(nodeIdForToken(tok)).toBe('n-owner-gone')
    forgetNodeToken('n-owner-gone')
    expect(nodeIdForToken(tok)).toBeUndefined()
    expect(isValidNodeToken(tok)).toBe(false)
  })
  it('re-mints a fresh binding after a reused node id', () => {
    const first = nodeToken('n-owner-reuse')
    forgetNodeToken('n-owner-reuse')
    const second = nodeToken('n-owner-reuse')
    expect(second).not.toBe(first)
    expect(nodeIdForToken(first)).toBeUndefined()
    expect(nodeIdForToken(second)).toBe('n-owner-reuse')
  })
})
