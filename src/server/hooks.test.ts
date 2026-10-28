import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// `forgetNodeToken` menyapu file settings node, jadi ia menyentuh data dir. Diarahkan ke temp
// supaya test ini tidak pernah mengutak-atik data dir pengguna.
process.env.WEBTERM_DATA_DIR = join(tmpdir(), 'webterm-hooks-test')

import type { AgentPermissionMode, AgentStatus } from '../shared/workspace'
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
  hookStatus,
  nodeToken,
  permissionModeFlag,
  stateVerified,
} from './hooks'

describe('hookStatus', () => {
  // Tabel LENGKAP event→status, satu baris per event yang dilanggani. Ditulis eksplisit supaya
  // setiap perubahan pemetaan harus melewati test ini, bukan lewat diam-diam.
  const TABLE: Record<string, AgentStatus | null> = {
    // Start-of-work yang jujur: ada pekerjaan karena ada yang memintanya.
    UserPromptSubmit: 'working',
    // Penjaga turn tetap hidup di tengah jalan.
    PreToolUse: 'working',
    PostToolUse: 'working',
    SubagentStart: 'working',
    SubagentStop: 'working',
    // Setiap jalur yang mengakhiri sebuah turn.
    Stop: 'waiting',
    StopFailure: 'waiting',
    Notification: 'waiting',
    PermissionRequest: 'blocked',
    SessionEnd: 'done',
    // Batas siklus hidup, BUKAN perubahan state (lihat doc `hookStatus`).
    SessionStart: null,
  }

  it('maps every subscribed event exactly as the table says', () => {
    for (const [event, want] of Object.entries(TABLE)) {
      expect(hookStatus({ hook_event_name: event })).toBe(want)
    }
  })

  it('covers every subscribed event and nothing it does not subscribe', () => {
    expect(Object.keys(TABLE).sort()).toEqual(CLAUDE_HOOK_EVENTS.map(hookEventName).sort())
  })

  it('does NOT report working for a session that has only just started (regression)', () => {
    // Bug nyata: node claude yang baru di-spawn, masih memperlihatkan banner sambutan dan belum
    // pernah diberi prompt, terbaca RUNNING di chrome node dan terhitung di seksi Running sidebar.
    // SessionStart menyala saat CLI start, jadi memetakannya ke 'working' adalah klaim tanpa bukti.
    expect(hookStatus({ hook_event_name: 'SessionStart' })).toBeNull()
    // Dan sinyal yang BOLEH menyatakan kerja tetap menyatakannya — jadi perbaikan ini tidak
    // sekadar membungkam badge.
    expect(hookStatus({ hook_event_name: 'UserPromptSubmit' })).toBe('working')
  })

  it('keeps SessionStart subscribed even though it carries no status', () => {
    // Ia hook pertama yang menyala, jadi ia pemasok `transcript_path` paling awal (api.ts memanen
    // field itu TERPISAH dari status). Mencabut langganannya membutakan konteks-tertaut sampai
    // prompt pertama.
    expect(CLAUDE_HOOK_EVENTS.map(hookEventName)).toContain('SessionStart')
  })

  it('no longer sniffs Notification text for permission wording', () => {
    // Heuristik lama memetakan ini ke 'blocked'; PermissionRequest sekarang satu-satunya sumber.
    const body = { hook_event_name: 'Notification', message: 'Claude needs your permission to run Bash' }
    expect(hookStatus(body as { hook_event_name?: string })).toBe('waiting')
  })
  it('returns null for an unknown event', () => {
    expect(hookStatus({ hook_event_name: 'Nope' })).toBeNull()
  })
})

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
