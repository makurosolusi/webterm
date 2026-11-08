import { writeFileSync } from 'node:fs'
import { claudeProtectionSettings } from './agentSandbox'
import { browserAllowRules } from './browserAgentShim'
import { TOKEN_HEADER } from './auth'
import { dataDir } from './config'
import { NODE_TOKEN_HEADER, nodeToken } from './hooksTokens'
import { claudeHeadersPath, claudeSettingsPath, ensureNodeSettingsDir, houseRulesPath } from './hooksPaths'
import { encodeQueryValue, shq } from './hooksQuote'
import { createLogger } from './logs'
import { HOUSE_RULES } from './webtermAwareness'
import { MCP_SERVER_NAME } from './mcp/mcp.paths'

const log = createLogger('hooks')

// ---------------------------------------------------------------------------------------------
// Langganan event hook.

/** Satu langganan hook terkelola: nama event, atau nama event PLUS `timeout` handler-nya. */
export type HookSubscription = string | { event: string; timeout: number }

/** Nama event sebuah langganan, dalam bentuk apa pun ia dideklarasikan. */
export const hookEventName = (e: HookSubscription): string => (typeof e === 'string' ? e : e.event)

/**
 * `timeout` (detik) yang kita tulis pada handler `PermissionRequest` claude. Default command-hook
 * claude hari ini juga 600 detik, tapi hook yang MENAHAN request menunggu Approve/Deny dari canvas
 * menunggu sampai `PERM_WAIT_SECS_INTERACTIVE` — jadi batas yang menjadi ukuran penahanan itu kita
 * tuliskan sendiri alih-alih meminjam default CLI yang bisa berubah di bawah kita.
 */
export const PERMISSION_REQUEST_HOOK_TIMEOUT_SECS = 600

/**
 * How long the server holds a `PermissionRequest` hook waiting for Allow/Deny from the webterm
 * Inbox (`permission/permission.wait.ts`) before answering "no decision", which drops Claude back to
 * its own terminal prompt. 10 s under `PERMISSION_REQUEST_HOOK_TIMEOUT_SECS` so the reply always
 * arrives before Claude cancels the hook (a cancelled hook's output is discarded). The on/off switch
 * is `settings.hookReplyApprovals`.
 */
export const PERM_WAIT_SECS_INTERACTIVE = 590

/**
 * Event hook Claude Code yang kita langgani. Sebelas, sama dengan `CLAUDE_HOOK_EVENTS` nodeterm
 * (`src/shared/agents/hook-events.ts`) — diverifikasi terhadap v0.4.5.
 *
 * Yang dulu hilang di webterm dan kenapa penting:
 *  - `StopFailure` menyala MENGGANTIKAN `Stop` saat sebuah turn berakhir karena error API/model.
 *    Tanpa itu badge status tersangkut di "working" setelah setiap turn yang gagal.
 *  - `PermissionRequest` adalah sinyal prompt-permission yang SEBENARNYA. Ia membawa `timeout`
 *    eksplisit karena hook terkelola menahannya (lihat PERM_WAIT_SECS_INTERACTIVE).
 *  - `SubagentStart`/`SubagentStop` adalah siklus hidup subagent claude sendiri. Keduanya TIDAK
 *    memetakan ke status node (lihat `hookStatus`); dilanggani karena POST-nya tetap membawa
 *    `transcript_path` yang dipanen `setTranscript` untuk konteks-tertaut.
 *
 * `SessionStart` TETAP dilanggani meski tidak lagi memetakan ke status apa pun (lihat `hookStatus`):
 * ia hook PERTAMA yang menyala, jadi ia yang memasok `transcript_path` ke `setTranscript`
 * (`api.ts`) — tanpa itu konteks-tertaut buta sampai prompt pertama dikirim.
 */
export const CLAUDE_HOOK_EVENTS: readonly HookSubscription[] = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'Notification',
  { event: 'PermissionRequest', timeout: PERMISSION_REQUEST_HOOK_TIMEOUT_SECS },
  'SessionEnd',
  'PreToolUse',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
]

/**
 * Isi file `--settings`: satu curl catch-all per event, mem-POST stdin hook ke endpoint
 * agent-status kita dengan key node id. Dikembalikan sebagai OBJEK supaya test bisa meng-assert
 * strukturnya tanpa mem-parse quoting shell.
 *
 * Token TIDAK PERNAH muncul di baris perintah, tidak sebagai nilai dan tidak sebagai ekspansi.
 * `curl` menerima `-H @<file>`: header (dan nilainya) dibaca dari sebuah file 0600 milik pengguna
 * (`claudeHeadersPath`), yang ditulis `writeClaudeSettings` tepat sebelum sesi diluncurkan. Dulu
 * baris ini berbunyi `-H "x-nodeterm-node-token: $NODETERM_NODE_TOKEN"`; shell meng-expand kedua
 * variabel SEBELUM `exec`, jadi token aslinya tetap mendarat di argv curl dan terbaca semua proses
 * pengguna lewat `ps`. Referensi env var hanya menyembunyikan nilainya dari teks settings, bukan
 * dari argv proses yang benar-benar berjalan.
 *
 * DUA header, bukan satu. `x-nodeterm-node-token` adalah identitas per-node (dibaca
 * `stateVerified`); `x-webterm-token` adalah token TRANSPORT yang menggerbangi seluruh `/api/`
 * (`authorizeRequest` di auth.ts) — tanpanya setiap POST hook dibalas 403 begitu token diset,
 * yang mematikan badge status DAN registrasi transcript (sumber data context-link).
 *
 * Keduanya memakai token NODE, bukan root `WEBTERM_TOKEN`. Node token hanya membuka
 * `/api/agent-status`, `/api/context-link`, dan `/api/control/*`, jadi bocornya file header tidak
 * memberi akses ke settings/workspace. Root token tidak pernah menyentuh disk.
 *
 * STDOUT DIBIARKAN HIDUP (`>/dev/null` dilepas): stdout hook adalah satu-satunya kanal yang Claude
 * Code sendiri buka untuk MENDORONG teks ke konteks agent (`hookSpecificOutput.additionalContext`
 * pada `SessionStart`/`UserPromptSubmit`) — dibuang, dan agent tak pernah tahu node tetangganya ada
 * sampai ia kebetulan memanggil skill-nya. Maka stderr dibungkam SENDIRI (`2>/dev/null`), tak lagi
 * digabung (`2>&1`): di stdout, pesan gagal-konek/DNS/timeout curl jadi sampah di konteks agent.
 * `|| true` tetap — hook yang gagal tidak boleh menggagalkan turn agent.
 */
export function claudeHooksSettings(nodeId: string, port: number): Record<string, unknown> {
  // Node id DIDARATKAN ke baris shell dan ke query string. Dua lapis, bukan satu:
  //  1. `encodeQueryValue` supaya id tidak bisa menutup argumen query atau menyelundupkan
  //     `&header=…` ke URL (id aman hari ini lewat `isSafeNodeId`; ini lapis kedua yang tetap
  //     benar kalau alfabetnya suatu saat dilebarkan), termasuk `'` yang `encodeURIComponent`
  //     biarkan mentah.
  //  2. `shq` — SELURUH URL jadi satu argumen single-quoted, jadi tidak ada metakarakter id yang
  //     bisa dibaca shell, dan `$` di dalamnya juga tidak di-expand.
  // Validasi (`isSafeNodeId`) tetap dilakukan di batas WebSocket; di sini pertahanannya quoting,
  // karena fungsi ini juga dipanggil dari test dan jalur lain.
  const url = `http://127.0.0.1:${port}/api/agent-status?node=${encodeQueryValue(nodeId)}`
  const cmd =
    `curl -s ${shq(url)} -H @${shq(claudeHeadersPath(nodeId))} ` +
    `--data-binary @- 2>/dev/null || true`
  const hooks: Record<string, unknown[]> = {}
  for (const e of CLAUDE_HOOK_EVENTS) {
    const timeout = typeof e === 'string' ? undefined : e.timeout
    hooks[hookEventName(e)] = [
      { matcher: '', hooks: [{ type: 'command', command: cmd, ...(timeout !== undefined ? { timeout } : {}) }] },
    ]
  }
  return { hooks }
}

/** Whole `--settings` object of a webterm Claude node: hooks + same-uid protection (`agentSandbox`). */
export function claudeNodeSettings(nodeId: string, port: number): Record<string, unknown> {
  const protection = claudeProtectionSettings(dataDir(), { ownHeaders: claudeHeadersPath(nodeId) })
  // The webterm MCP tools are pre-allowed in Claude: the webterm policy engine already decides every
  // call server-side (mcp/mcp.tools.ts), so a second Claude prompt per tool would only add friction.
  // Same for the browser CLI: the server checks the cable, agent control and policy on every verb.
  const permissions = { ...(protection.permissions as Record<string, unknown>), allow: [`mcp__${MCP_SERVER_NAME}`, ...browserAllowRules()] }
  return { ...claudeHooksSettings(nodeId, port), ...protection, permissions }
}

/**
 * Tulis settings hook node ini ke file dan kembalikan path-nya.
 *
 * Lewat FILE, bukan blob JSON inline: baris peluncuran bisa dibungkus perintah pihak ketiga
 * (`envman -e p:e -- claude`), dan pembungkus seperti itu memindai argumennya sendiri — URL callback
 * `http://127.0.0.1:...` di dalam blob terbaca sebagai referensi `slug:path` miliknya, yang membuat
 * peluncuran mati sebelum claude jalan. Sebuah path tidak memuat `:` sama sekali.
 *
 * Mode 0600: isinya tidak lagi memuat token (header dibaca curl dari file terpisah), tapi file ini
 * mengarahkan ke mana sebuah sesi agent mem-POST — bukan sesuatu yang perlu bisa ditulis pengguna
 * lain.
 */
export function writeClaudeSettings(nodeId: string, port: number): string {
  const path = claudeSettingsPath(nodeId)
  try {
    ensureNodeSettingsDir()
    // Ditulis SEBELUM settings dikembalikan: baris hook menunjuk ke file ini, dan sesi agent bisa
    // langsung menjalankan hook pertamanya begitu claude hidup.
    writeNodeHeaders(nodeId)
    writeFileSync(path, JSON.stringify(claudeNodeSettings(nodeId, port)), { mode: 0o600 })
  } catch (err) {
    log.error('hooks.error', 'Failed to write hook settings', { ids: { nodeId }, error: err instanceof Error ? err.name : 'unknown', code: (err as { code?: unknown } | null)?.code })
    throw err
  }
  log.info('hooks.install', 'Installed hook settings', { ids: { nodeId }, events: CLAUDE_HOOK_EVENTS.length })
  return path
}

/**
 * File header yang dibaca `curl -H @file` (0600). Nilai token hidup DI SINI, bukan di argv dan
 * bukan di env: hook claude DAN shim skill (context-link, browser) semua agent membacanya lewat
 * path di `WEBTERM_NODE_HEADERS`. Sandbox claude hanya membuka file milik node itu sendiri.
 *
 * Ditulis ulang setiap peluncuran supaya token node yang baru (proses restarted) ikut. Setelah
 * ada, file ini hanya bisa dibaca pemiliknya.
 */
export function writeNodeHeaders(nodeId: string): string {
  ensureNodeSettingsDir()
  const path = claudeHeadersPath(nodeId)
  const token = nodeToken(nodeId)
  const lines = [`${NODE_TOKEN_HEADER}: ${token}`, `${TOKEN_HEADER}: ${token}`]
  // `mode` 0600 berlaku saat file dibuat; berkas ini tidak pernah ada sebelum perubahan ini, dan
  // penulisan ulang mempertahankan modenya.
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 })
  return path
}

/**
 * Tulis `HOUSE_RULES` ke file milik webterm dan kembalikan path-nya, untuk
 * `--append-system-prompt-file`. Lewat FILE dengan alasan yang sama seperti `writeClaudeSettings`
 * (pembungkus peluncuran memindai argumen; teks aturan memuat `:`). Ditulis ulang tiap peluncuran
 * supaya teks terbaru ikut. Tidak pernah menyentuh repo user maupun `~/.claude`.
 */
export function writeHouseRules(): string {
  const path = houseRulesPath()
  try {
    ensureNodeSettingsDir()
    writeFileSync(path, `${HOUSE_RULES}\n`, { mode: 0o600 })
  } catch (err) {
    log.error('hooks.error', 'Failed to write webterm house rules', { error: err instanceof Error ? err.name : 'unknown', code: (err as { code?: unknown } | null)?.code })
    throw err
  }
  return path
}
