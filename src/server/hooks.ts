import { isPermissionMode, type AgentPermissionMode } from '../shared/workspace'
import { PERM_WAIT_SECS_INTERACTIVE, writeClaudeSettings, writeHouseRules } from './hooksSettings'
import { NODE_HEADERS_ENV } from './hooksTokens'
import { claudeHeadersPath } from './hooksPaths'
import { shq } from './hooksQuote'

// Modul ini dulu memuat SEMUANYA (token, settings, perakitan baris peluncuran). Ia sekarang
// menyisakan bagian "apa yang dibawa sesi agent" dan MEMBAGI sisanya ke modul bersaudara
// (`hooksTokens`, `hooksSettings`, `hooksPaths`, `hooksQuote`). Re-export di bawah menjaga kontrak
// lama: pemanggil tetap mengimpor semuanya dari `./hooks`.
export {
  CLAUDE_HOOK_EVENTS,
  PERM_WAIT_SECS_INTERACTIVE,
  PERMISSION_REQUEST_HOOK_TIMEOUT_SECS,
  claudeHooksSettings,
  claudeNodeSettings,
  hookEventName,
  writeClaudeSettings,
  writeNodeHeaders,
  type HookSubscription,
} from './hooksSettings'
export {
  NODE_HEADERS_ENV,
  NODE_TOKEN_ENV,
  NODE_TOKEN_HEADER,
  forgetNodeToken,
  isValidNodeToken,
  nodeIdForToken,
  nodeToken,
  stateVerified,
} from './hooksTokens'

/**
 * Env var yang harus dibawa sebuah sesi agent. DIKEMBALIKAN, bukan ditulis: pemanggil (jalur spawn
 * PTY) yang menggabungkannya ke env proses. Hanya PATH file header, tidak pernah nilai token
 * (`NODE_HEADERS_ENV`); file-nya ditulis `writeNodeHeaders` sebelum spawn.
 *
 * `hookReplyApprovals` off ⇒ `NODETERM_PERM_WAIT_SECS` ABSEN ⇒ perilaku lama persis: hook permission
 * tidak menahan apa pun dan claude langsung menampilkan prompt interaktifnya.
 */
export function hookEnv(nodeId: string, opts?: { hookReplyApprovals?: boolean }): Record<string, string> {
  const waitSecs = opts?.hookReplyApprovals ? PERM_WAIT_SECS_INTERACTIVE : 0
  return {
    [NODE_HEADERS_ENV]: claudeHeadersPath(nodeId),
    ...(waitSecs > 0 ? { NODETERM_PERM_WAIT_SECS: String(waitSecs) } : {}),
  }
}

/**
 * Flag `--permission-mode` untuk sebuah mode. `manual` tidak menghasilkan flag, jadi perintahnya
 * tetap polos — persis perintah yang webterm kirim sebelum setting ini ada.
 *
 * Mode divalidasi ULANG di sini meski parameternya bertipe: `AgentPermissionMode` hanya janji
 * compile-time, sedangkan nilainya datang dari settings yang bisa diedit tangan / lewat HTTP
 * sebelum diinterpolasikan ke baris perintah shell.
 */
export function permissionModeFlag(mode: AgentPermissionMode | undefined): string {
  if (!isPermissionMode(mode) || mode === 'manual') return ''
  return `--permission-mode ${mode}`
}

/**
 * Flag yang ditempelkan ke baris peluncuran claude (TANPA spasi di depan; pemanggil menyambung
 * dengan satu spasi). resume=false → sesi baru lewat `--session-id`; resume=true → lanjut lewat
 * `--resume`.
 *
 * `permissionMode` MASUK sebagai parameter, tidak dibaca dari store settings di sini: modul ini
 * dipakai di jalur spawn dan di test, dan integrator yang tahu settings mana yang berlaku.
 */
export function buildClaudeFlags(
  nodeId: string,
  sessionId: string,
  port: number,
  resume: boolean,
  opts?: {
    permissionMode?: AgentPermissionMode
    /** Di-inject supaya test tetap bebas I/O (pola sama dengan `unwrapMissingWrapper` di pty.ts). */
    writeSettings?: (nodeId: string, port: number) => string
    /** Sama: penulis file aturan rumah webterm (`--append-system-prompt-file`). */
    writeRules?: () => string
  }
): string {
  const idFlag = resume ? `--resume ${sessionId}` : `--session-id ${sessionId}`
  const perm = permissionModeFlag(opts?.permissionMode)
  const settings = (opts?.writeSettings ?? writeClaudeSettings)(nodeId, port)
  // Bagian STABIL kesadaran webterm masuk system prompt; bagian dinamis lewat hook (webtermAwareness).
  const rules = (opts?.writeRules ?? writeHouseRules)()
  return [idFlag, perm, `--settings ${shq(settings)}`, `--append-system-prompt-file ${shq(rules)}`].filter(Boolean).join(' ')
}
