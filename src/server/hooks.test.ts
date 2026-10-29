import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// `forgetNodeToken` menyapu file settings node, jadi ia menyentuh data dir. Diarahkan ke temp
// supaya test ini tidak pernah mengutak-atik data dir pengguna.
process.env.WEBTERM_DATA_DIR = join(tmpdir(), 'webterm-hooks-test')

import type { AgentPermissionMode } from '../shared/workspace'
import { TOKEN_HEADER } from './auth'
import {
  CLAUDE_HOOK_EVENTS,
  NODE_TOKEN_ENV,
  NODE_TOKEN_HEADER,
  PERMISSION_REQUEST_HOOK_TIMEOUT_SECS,
  PERM_WAIT_SECS_INTERACTIVE,
  buildClaudeFlags,
  claudeHooksSettings,
  forgetNodeToken,
  hookEnv,
  hookEventName,
  nodeToken,
  permissionModeFlag,
  stateVerified,
} from './hooks'
import { nextHookContext } from './hookContext'

/** Baris curl yang dibangun untuk satu node, diambil dari event `Stop` (semua event memakai baris
 *  yang sama persis — lihat test "subscribes the 11 nodeterm events"). */
function commandFor(nodeId: string): string {
  const hooks = claudeHooksSettings(nodeId, 8700).hooks as Record<string, unknown[]>
  return (hooks['Stop'][0] as { hooks: { command: string }[] }).hooks[0].command
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
  it('sends the node token by env-var REFERENCE, never its value', () => {
    const tok = nodeToken('n-ref')
    const cmd = (
      (claudeHooksSettings('n-ref', 8700).hooks as Record<string, unknown[]>)['Stop'][0] as {
        hooks: { command: string }[]
      }
    ).hooks[0].command
    expect(cmd).toContain(`${NODE_TOKEN_HEADER}: $${NODE_TOKEN_ENV}`)
    expect(cmd).not.toContain(tok)
  })
  it('sends the transport token too, also by reference, without dropping the node token', () => {
    // Seluruh `/api/` digerbangi `authorize()` lewat `x-webterm-token`, jadi hook butuh KEDUA
    // header. Nama env var ditulis literal di sini, bukan di-import: justru itu yang membuat
    // test ini gagal kalau ejaan di hooks.ts berubah.
    const cmd = commandFor('n-transport')
    expect(cmd).toContain(`${TOKEN_HEADER}: $WEBTERM_TOKEN`)
    expect(cmd).toContain(`${NODE_TOKEN_HEADER}: $${NODE_TOKEN_ENV}`)
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
// Apa yang BENAR-BENAR diterima curl. Bentuk string saja tidak membuktikan apa pun: ekspansi tak
// terkutip akan tetap "memuat" header-nya sambil memecahnya jadi beberapa argumen. Jadi `curl`
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
  it('passes each token as ONE argument, special characters intact', () => {
    const argv = curlArgv(commandFor('n-argv'), {
      WEBTERM_TOKEN: FAKE_TRANSPORT_TOKEN,
      [NODE_TOKEN_ENV]: FAKE_NODE_TOKEN,
    })
    // Elemen utuh, bukan `toContain` pada string gabungan: inilah yang membedakan satu argumen
    // dari tiga pecahan hasil word splitting.
    expect(argv).toContain(`${TOKEN_HEADER}: ${FAKE_TRANSPORT_TOKEN}`)
    expect(argv).toContain(`${NODE_TOKEN_HEADER}: ${FAKE_NODE_TOKEN}`)
    // Tiap nilai header didahului `-H`-nya sendiri.
    expect(argv[argv.indexOf(`${TOKEN_HEADER}: ${FAKE_TRANSPORT_TOKEN}`) - 1]).toBe('-H')
    expect(argv[argv.indexOf(`${NODE_TOKEN_HEADER}: ${FAKE_NODE_TOKEN}`) - 1]).toBe('-H')
    // Tidak ada pecahan nyasar: token ber-spasi yang ter-split akan memunculkan `ke$it's` sendirian.
    expect(argv).not.toContain(`ke$it's`)
    expect(argv).not.toContain(TOKEN_HEADER + ':')
  })
  it('stays well-formed when no token is configured', () => {
    // Tanpa `WEBTERM_TOKEN` barisnya tetap mengemit header bernilai kosong sebagai DUA argumen
    // (`-H`, lalu nilai kosongnya) — curl sendiri yang membuangnya, dan server di keadaan ini tidak
    // menegakkan token apa pun. Yang dijaga di sini: barisnya tidak berantakan.
    const argv = curlArgv(commandFor('n-argv-empty'), { [NODE_TOKEN_ENV]: FAKE_NODE_TOKEN })
    expect(argv).toContain(`${TOKEN_HEADER}: `)
    expect(argv[argv.indexOf(`${TOKEN_HEADER}: `) - 1]).toBe('-H')
    // Node token tetap lewat: token transport yang absen tidak boleh menggeser argumen lain.
    expect(argv).toContain(`${NODE_TOKEN_HEADER}: ${FAKE_NODE_TOKEN}`)
    expect(argv).toContain('--data-binary')
    expect(argv.filter((a) => a === '-H')).toHaveLength(2)
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
  it('always carries the node token', () => {
    expect(hookEnv('n-env')[NODE_TOKEN_ENV]).toBe(nodeToken('n-env'))
  })
  it('sets NODETERM_PERM_WAIT_SECS when hook-reply approvals are on', () => {
    expect(hookEnv('n-env', { hookReplyApprovals: true }).NODETERM_PERM_WAIT_SECS).toBe(
      String(PERM_WAIT_SECS_INTERACTIVE)
    )
  })
  it('omits NODETERM_PERM_WAIT_SECS when off (legacy behaviour, exactly)', () => {
    expect(hookEnv('n-env', { hookReplyApprovals: false })).not.toHaveProperty('NODETERM_PERM_WAIT_SECS')
    expect(hookEnv('n-env')).not.toHaveProperty('NODETERM_PERM_WAIT_SECS')
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
  const flags = (resume: boolean, permissionMode?: AgentPermissionMode) =>
    buildClaudeFlags('n1', 'uuid-x', 8700, resume, { permissionMode, writeSettings })

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
// ini. Yang bisa: membaca source-nya dan menolak bentuk yang salah — pola yang sama dengan
// `src/client/workspaceCommit.test.ts`.
const apiSrc = () => readFileSync(fileURLToPath(new URL('./api.ts', import.meta.url)), 'utf8')

/** Blok `if (path === '/api/agent-status' ...)` saja, sampai `}` penutupnya di indentasi 2 spasi. */
const agentStatusBlock = (s: string) => s.split("path === '/api/agent-status'")[1]?.split('\n  }')[0] ?? ''

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
    const b = agentStatusBlock(apiSrc())
    // Dihitung dulu: blok kosong akan meluluskan guard apa pun tanpa menjaga apa-apa.
    expect(b.length).toBeGreaterThan(0)
    expect(repliesWithHookPayload(b)).toBe(true)
    // 204 tetap TANPA body — `json(res, 204)` pun akan tetap body-less, tapi jalur lamanya dijaga
    // apa adanya supaya kontrak 204-nya tidak bergeser diam-diam.
    expect(b).toContain('res.statusCode = 204; res.end(); return')
  })

  it('menjalankan jalur status/transcript sebelum menghitung pengumuman', () => {
    expect(statusPathRunsFirst(agentStatusBlock(apiSrc()))).toBe(true)
  })

  it('tidak menduplikasi keputusan event di route — itu milik hookContext', () => {
    // `nextHookContext` sendiri yang memutuskan event mana layak diumumkan. Menyalin daftarnya ke
    // sini berarti dua tempat harus berubah bersamaan, dan yang satu akan tertinggal.
    const b = agentStatusBlock(apiSrc())
    expect(b).not.toContain('SessionStart')
    expect(b).not.toContain("'UserPromptSubmit'")
  })

  it('kedua guard menolak bentuk lama route-nya', () => {
    expect(repliesWithHookPayload(OLD_ROUTE)).toBe(false)
    expect(statusPathRunsFirst(OLD_ROUTE)).toBe(false)
  })
})
