// Skema settings webterm. HANYA kunci yang punya konsumen nyata di webterm.
//
// SENGAJA TIDAK ADA:
//  - Famili tmux/zellij (`tmuxEnabled`, `sessionBackend`, `tmuxLeadPaneWidth`, …): webterm tidak
//    punya multiplexer, jadi UI-nya akan jadi saklar mati.
//  - Kunci khusus Electron (`notch*`, `uiScale`, `tabBarHeight`, `runInBackgroundOnClose`,
//    `confirmBeforeQuit`, `keepAwakeWhileAgentsWork`, `phoneAccessEnabled`, `telemetryEnabled`,
//    `license`): tidak ada permukaan yang mewujudkannya di browser.
//  - `modelGateway` / `claudeAccounts`.
//
// KEAMANAN. Settings melintas HTTP tanpa redaksi (`GET /api/settings`), jadi TIDAK ADA kunci yang boleh
// memuat rahasia: tidak ada API key, token, atau baseUrl bergantung-kredensial. Satu-satunya
// kunci bernilai env adalah `CustomAgent.env`, dan ia hanya boleh berisi literal NON-secret atau
// rujukan `${env:NAME}` (nilai asli dibaca server dari env proses, tak pernah ikut GET). Kunci
// berpola KEY|TOKEN|SECRET|PASSWORD|AUTH wajib rujukan; `customAgent.schema.ts` menolak literalnya
// (PUT -> 400). Kalau nanti ada kunci yang bisa memuat rahasia, ia WAJIB ditandai di sini dan
// diredaksi di jalur HTTP — jangan tambahkan diam-diam.

import { normalizeCustomAgents, type CustomAgentError } from './customAgent.schema'
import type { SearchEngine } from './browser.omnibox'
import { clampSetting, SETTING_RANGES, type RangedKey } from './settings.ranges'
import { normalizeClaudeProfiles, seedClaudeProfiles } from './claudeLaunch/claudeLaunch.profiles'
import { DEFAULT_CANVAS_BACKGROUND, normalizeCanvasBackground, normalizeWorkspaceBackgrounds, type CanvasBackground } from './canvasBackground.schema'
import type { AppTheme, TerminalSettings } from './settings.terminal'
import type { AgentSettings } from './settings.agent'
import { normalizeKeybindings } from './settings.keybindings'
import { normalizeProjectModels } from './settings.projectModels'
import { normalizeProjectApprovalLevels } from './settings.projectApprovalLevels'
import { normalizeInputHistory } from './settings.inputHistory'
import { DEFAULT_SETUP, normalizeSetup, type SetupState } from './settings.setup'
import { DEFAULT_APPROVAL_LEVEL, approvalLevelOf, approvalLevelPatch } from './settings.approvalLevel'
import { DEFAULT_PERMISSION_ROUTING, permissionRoutingOf } from './settings.permissionRouting'

export type { TerminalCursorStyle, TerminalShortcutPolicy, AppTheme } from './settings.terminal'
export { KEYBINDINGS_LIMITS, normalizeKeybindings } from './settings.keybindings'
export { SETUP_STEPS, type SetupStep, type SetupStepState, type SetupState } from './settings.setup'

// `CustomAgent` (BYO CLI) hidup di `customAgent.schema.ts`; `baseAgent` membuatnya MEWARISI
// kapabilitas harness builtin lewat `capabilityAgentId` (tanpa itu hanya spawn + judul terminal).
export type { CustomAgent, CustomAgentLaunch } from './customAgent.schema'

/** Quick move & resize modifier: `cmdCtrl` = ⌘⌃ (Ctrl+Alt off macOS), `cmdShift` = ⌘⇧ (Ctrl+Shift). */
export const QUICK_DRAG_PRESETS = ['cmdCtrl', 'cmdShift', 'off'] as const
export type QuickDragPreset = (typeof QUICK_DRAG_PRESETS)[number]

/** Full settings shape: terminal + agent slices (own files) plus the canvas/app keys below. */
export interface Settings extends TerminalSettings, AgentSettings {
  // --- Canvas ----------------------------------------------------------------------------------
  gridSize: number
  /** Snap saat drag: selagi ON, menggeser node membulatkan posisinya ke grid. */
  snapToGrid: boolean
  /** Ukuran default (px) untuk node terminal/agent BARU. Node yang sudah ada tetap memakai ukuran
   *  yang tersimpan bersamanya. */
  defaultNodeWidth: number
  defaultNodeHeight: number
  /** Gambar grid titik di canvas. Tampilan saja — snapping tidak berubah. */
  canvasDots: boolean
  /** Modifier held for "Quick move & resize" (drag anywhere on a node). Normalized on load. */
  quickDrag: QuickDragPreset
  /** Status bar at the bottom of terminal and agent nodes (session facts + anomaly badges). */
  nodeStatusBar: boolean
  /** Tampilan chrome APP (panel, header node, menu). `auto` (default, "System") mengikuti mode
   *  terang/gelap OS (`prefers-color-scheme`); `dark`/`light` memakunya. */
  appTheme: AppTheme
  /** Cable (edge) color: `'default'` = theme color, otherwise `#rrggbb`. Normalized on load. */
  edgeColor: string
  /** Cable thickness in px (`SETTING_RANGES.edgeWidth`). */
  edgeWidth: number
  /** Canvas wallpaper (default / color / gradient / image). See `canvasBackground.schema.ts`. */
  canvasBackground: CanvasBackground
  /** Per-workspace wallpaper overrides by workspace id; absent = same as global. */
  canvasBackgroundByWorkspace: Record<string, CanvasBackground>

  // --- Preview ---------------------------------------------------------------------------------
  /** Buka file Markdown (.md, .markdown, …) dalam preview terender alih-alih editor kode. Hanya
   *  menentukan tampilan saat node editor DIBUKA — toggle Preview/Edit node tetap bisa berpindah
   *  dua arah. */
  openMarkdownPreview: boolean

  // --- Browser ---------------------------------------------------------------------------------
  /** Mesin pencari omnibox node browser untuk ketikan yang bukan alamat (pilihan meniru Orca).
   *  Divalidasi di titik pakai lewat `toSearchEngine`: nilai tak dikenal jatuh ke Google. */
  browserSearchEngine: SearchEngine

  // --- Keyboard --------------------------------------------------------------------------------
  /** User keybinding overrides, VS Code `keybindings.json` style: command id → chord
   *  (`Mod+Shift+F`), or `null` to remove that command's default. Validated by
   *  `normalizeKeybindings`; command ids live in the client registry (`commandRegistry.ts`). */
  keybindings: Record<string, string | null>

  // --- Projects --------------------------------------------------------------------------------
  /** Where Clone repository / New project put folders. Empty = `~/webterm/projects`. Validated on
   *  the server at use (absolute, not inside the data dir, not a file); an invalid value falls back
   *  to the default instead of failing a clone. */
  defaultProjectsFolder: string

  // --- Input history ---------------------------------------------------------------------------
  /** Values typed into settings comboboxes, per field id, most recent first (`settings.inputHistory.ts`).
   *  Shown as "Recent" suggestions on every device; never holds secrets. */
  inputHistory: Record<string, string[]>

  // --- Cost ----------------------------------------------------------------------------------
  /** One Needs-you notice per UTC day once today's spend passes $10 (server/cost/costDailyWarning.ts). Off by
   *  default (SAFEGUARDS); turning it off closes the open ones. The hard daily cap is separate and unaffected. */
  dailySpendWarning: boolean

  // --- First run -------------------------------------------------------------------------------
  /** First-run wizard progress (`settings.setup.ts`); `completedAt` null = wizard not finished. */
  setup: SetupState
}

export const DEFAULT_SETTINGS: Settings = {
  fontSize: 13,
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  fontWeight: 400,
  fontWeightBold: 700,
  drawBoldTextInBrightColors: true,
  terminalLineHeight: 1,
  terminalLetterSpacing: 0,
  // Id tema adalah permukaan TERLIHAT (muncul di dropdown settings), jadi ia
  // memakai nama webterm.
  terminalTheme: 'webterm-dark',
  terminalMinContrast: 1,
  cursorStyle: 'block',
  cursorBlink: true,
  // Pertahankan tanda hubung, garis bawah, slash dan titik di dalam kata supaya identifier dan
  // path terseleksi utuh.
  terminalWordSeparator: " ()[]{}',\"",
  copyOnSelect: false,
  terminalFontZoomKeys: true,
  terminalShortcutPolicy: 'app-first',
  defaultShell: '',
  // 256 KiB — persis `SCROLLBACK_BYTES` yang berjalan di server hari ini. Lihat doc kuncinya.
  scrollbackBytes: 256 * 1024,
  // 10.000 baris — angka yang dipakai xterm hari ini, jadi mengangkatnya ke
  // settings tidak mengubah perilaku. Lihat doc kuncinya.
  scrollbackLines: 10_000,
  agentLaunchCommands: {},
  claudeLaunchProfiles: [],
  defaultClaudeProfileId: 'default',
  centralClaudeProfileId: '',
  customAgents: [],
  disabledAgents: [],
  claudePermissionMode: 'auto',
  hookReplyApprovals: true,
  skipApprovals: true,
  // The default level decides the three keys above (one line in settings.approvalLevel.ts).
  ...approvalLevelPatch(DEFAULT_APPROVAL_LEVEL),
  agentApprovalLevel: DEFAULT_APPROVAL_LEVEL,
  permissionRouting: DEFAULT_PERMISSION_ROUTING,
  centralCheckins: true,
  centralCheckinDailyLimit: 10,
  projectModels: {},
  projectApprovalLevels: {},
  gridSize: 24,
  snapToGrid: false,
  defaultNodeWidth: 640,
  defaultNodeHeight: 440,
  canvasDots: true,
  quickDrag: 'cmdCtrl',
  nodeStatusBar: true,
  appTheme: 'auto',
  edgeColor: 'default',
  edgeWidth: 2,
  canvasBackground: DEFAULT_CANVAS_BACKGROUND,
  canvasBackgroundByWorkspace: {},
  openMarkdownPreview: true,
  browserSearchEngine: 'google',
  keybindings: {},
  defaultProjectsFolder: '',
  inputHistory: {},
  dailySpendWarning: false,
  setup: DEFAULT_SETUP,
}


/** Builtin ids before the Claude-first cut; only used to scrub stale settings keys. */
const RETIRED_AGENT_IDS: readonly string[] = ['codex', 'gemini', 'opencode', 'grok', 'copilot', 'antigravity', 'cursor']

const HEX_COLOR = /^#[0-9a-f]{6}$/i

const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]

/**
 * Gabungkan objek settings yang mungkin parsial / dari versi lain di atas `DEFAULT_SETTINGS`.
 *
 * Shallow merge sudah cukup DI SINI, dan itu bukan kebetulan: satu-satunya kunci bernilai objek
 * (`agentLaunchCommands`) defaultnya `{}`, sehingga objek parsial yang tersimpan tidak bisa
 * menjatuhkan apa pun. deep-merge satu level baru perlu bila objek bersarang punya default BERISI — sebuah objek parsial dari file lama akan
 * menimpanya satu-untuk-satu dan "silently drop the new key". Aturannya: begitu ada kunci objek
 * dengan default tidak kosong ditambahkan ke skema ini, ia WAJIB di-merge satu level di sini.
 *
 * Nilainya bisa diedit tangan dan datang lewat HTTP, jadi ini juga batas input: sebuah nilai
 * hanya dipakai bila bentuk dasarnya cocok dengan default (typeof + array-ness). Kunci yang tidak
 * dikenal dibuang, sehingga sampah tidak menumpuk di store.
 *
 * Pencocokan bentuk BUKAN validasi enum — `cursorStyle: 'blokk'` lolos sebagai string. Nilai enum
 * divalidasi ulang di titik pemakaian (pola `isPermissionMode` di `workspace.ts`), karena di
 * situlah konsekuensinya ada.
 */
export function mergeSettings(saved: unknown, onInvalidAgents?: (errors: CustomAgentError[]) => void): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return out
  const src = saved as Record<string, unknown>
  for (const key of SETTINGS_KEYS) {
    const v = src[key]
    if (v === undefined || v === null) continue // typeof null === 'object'; tak ada default null
    const d = DEFAULT_SETTINGS[key]
    if (typeof v !== typeof d) continue
    if (Array.isArray(v) !== Array.isArray(d)) continue
    // Angka dijepit ke rentang tabel (muat dari DB maupun PUT): nilai di luar rentang jadi batasnya,
    // NaN jadi default. Kunci number tanpa entri tabel digagalkan tes, bukan dilewatkan diam-diam.
    ;(out as unknown as Record<string, unknown>)[key] =
      typeof v === 'number' && key in SETTING_RANGES
        ? clampSetting(key as RangedKey, v, d as number)
        : v
  }
  // `customAgents` disaring per elemen (mode load: buang yang rusak, tak melempar, tak menulis
  // balik); `onInvalidAgents` memberi pemanggil server kesempatan `log.warn` tanpa isi.
  // Nilai `keybindings` disaring per entri (bentuk objek saja tidak cukup: nilainya wajib string/null).
  out.keybindings = normalizeKeybindings(src.keybindings)
  // Claude-first: only the claude launch override survives; stale keys of the retired builtins
  // (codex, gemini, …) are dropped on load. Their ids leave `disabledAgents` too — custom ids stay.
  const claudeCmd = out.agentLaunchCommands.claude
  out.agentLaunchCommands = typeof claudeCmd === 'string' ? { claude: claudeCmd } : {}
  out.disabledAgents = out.disabledAgents.filter((id) => !RETIRED_AGENT_IDS.includes(id))
  out.claudeLaunchProfiles = normalizeClaudeProfiles(src.claudeLaunchProfiles)
  // Nested object with a non-empty default: normalized field by field, never shallow-taken.
  out.canvasBackground = normalizeCanvasBackground(src.canvasBackground)
  out.canvasBackgroundByWorkspace = normalizeWorkspaceBackgrounds(src.canvasBackgroundByWorkspace)
  out.projectModels = normalizeProjectModels(src.projectModels)
  out.projectApprovalLevels = normalizeProjectApprovalLevels(src.projectApprovalLevels)
  out.inputHistory = normalizeInputHistory(src.inputHistory)
  out.setup = normalizeSetup(src.setup)
  // Enum: shape matching lets any string through, so an unknown preset falls back to the default.
  out.permissionRouting = permissionRoutingOf(out.permissionRouting)
  if (!QUICK_DRAG_PRESETS.includes(out.quickDrag)) out.quickDrag = DEFAULT_SETTINGS.quickDrag
  if (out.edgeColor !== 'default' && !HEX_COLOR.test(out.edgeColor)) out.edgeColor = DEFAULT_SETTINGS.edgeColor
  Object.assign(out, seedClaudeProfiles(src, out.agentLaunchCommands.claude))
  const agents = normalizeCustomAgents(src.customAgents, 'load')
  out.customAgents = agents.agents
  if (agents.errors.length) onInvalidAgents?.(agents.errors)
  // Derived, never trusted from storage: the keys it maps to are the source of truth.
  out.agentApprovalLevel = approvalLevelOf(out)
  return out
}
