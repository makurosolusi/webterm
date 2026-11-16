import { isPermissionMode, type AgentPermissionMode } from '../shared/workspace'
import { writeClaudeSettings, writeHouseRules } from './hooksSettings'
import { NODE_HEADERS_ENV } from './hooksTokens'
import { claudeHeadersPath } from './hooksPaths'
import { shq } from './hooksQuote'
import { writeClaudeMcpConfig } from './mcp/mcp.launch'
import { explorePluginFlag, writeExplorePlugin } from './subagents/exploreAgent'

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
  NODE_TOKEN_HEADERS,
  forgetNodeToken,
  isValidNodeToken,
  nodeIdForToken,
  nodeToken,
  nodeTokenFrom,
  stateVerified,
} from './hooksTokens'

/**
 * Env var yang harus dibawa sebuah sesi agent. DIKEMBALIKAN, bukan ditulis: pemanggil (jalur spawn
 * PTY) yang menggabungkannya ke env proses. Hanya PATH file header, tidak pernah nilai token
 * (`NODE_HEADERS_ENV`); file-nya ditulis `writeNodeHeaders` sebelum spawn.
 *
 * Hook-reply approvals do NOT travel through env: the managed PermissionRequest hook holds for
 * `PERM_WAIT_SECS_INTERACTIVE` (hooksSettings.ts) and the server answers it
 * (permission/permission.runtime.ts).
 */
// `_opts` is ignored. Kept only so sessions.ts:105 (still passing `{ hookReplyApprovals }`) compiles;
// drop it together with that argument and `SessionsOptions.hookReplyApprovals` (api.ts:86).
export function hookEnv(nodeId: string, _opts?: { hookReplyApprovals?: boolean }): Record<string, string> {
  return { [NODE_HEADERS_ENV]: claudeHeadersPath(nodeId) }
}

/**
 * Flag `--permission-mode` untuk sebuah mode, dengan nama CLI yang sama dengan Agent Chat
 * (`agentChatPermissionMode`): `manual` → `default`. Mode SELALU dikirim eksplisit — sejak Claude
 * Code v2.1.283 mode awal bawaan adalah `auto`, jadi perintah polos tidak lagi berarti "tanya".
 * Bila `auto` tidak tersedia (model/plan/org), CLI sendiri jatuh ke `default`
 * (code.claude.com/docs/en/permission-modes).
 *
 * Mode divalidasi ULANG di sini meski parameternya bertipe: `AgentPermissionMode` hanya janji
 * compile-time, sedangkan nilainya datang dari settings yang bisa diedit tangan / lewat HTTP
 * sebelum diinterpolasikan ke baris perintah shell. Absen/asing = tanpa flag.
 */
export function permissionModeFlag(mode: AgentPermissionMode | undefined): string {
  if (!isPermissionMode(mode)) return ''
  return `--permission-mode ${mode === 'manual' ? 'default' : mode}`
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
    /** Same: writer of the node's `--mcp-config` file (`webterm mcp`, mcp/mcp.launch.ts). */
    writeMcp?: (nodeId: string, port: number) => string
    /** Same: writer of the session-only plugin holding the `webterm:explore` subagent (subagents/exploreAgent.ts). */
    writePlugin?: () => string
  }
): string {
  const idFlag = resume ? `--resume ${sessionId}` : `--session-id ${sessionId}`
  const perm = permissionModeFlag(opts?.permissionMode)
  const settings = (opts?.writeSettings ?? writeClaudeSettings)(nodeId, port)
  // Bagian STABIL kesadaran webterm masuk system prompt; bagian dinamis lewat hook (webtermAwareness).
  const rules = (opts?.writeRules ?? writeHouseRules)()
  // webterm MCP server, added next to the user's own servers (no --strict-mcp-config). LAST on
  // purpose: `--mcp-config <configs...>` is variadic and would swallow any argument after it.
  const mcp = (opts?.writeMcp ?? writeClaudeMcpConfig)(nodeId, port)
  const plugin = explorePluginFlag(opts?.writePlugin ?? writeExplorePlugin)
  return [idFlag, perm, `--settings ${shq(settings)}`, `--append-system-prompt-file ${shq(rules)}`, plugin, `--mcp-config ${shq(mcp)}`].filter(Boolean).join(' ')
}
