// Skema settings webterm. Porting ramping dari nodeterm `src/shared/types.ts` (interface Settings,
// ±90 kunci) — HANYA kunci yang punya konsumen nyata di webterm, dengan nilai default persis dari
// nodeterm supaya pengguna yang pindah tidak melihat tampilan berubah.
//
// SENGAJA TIDAK DIPORT:
//  - Famili tmux/zellij (`tmuxEnabled`, `sessionBackend`, `tmuxLeadPaneWidth`, …): webterm tidak
//    punya multiplexer, jadi UI-nya akan jadi saklar mati.
//  - Kunci khusus Electron (`notch*`, `uiScale`, `tabBarHeight`, `runInBackgroundOnClose`,
//    `confirmBeforeQuit`, `keepAwakeWhileAgentsWork`, `phoneAccessEnabled`, `telemetryEnabled`,
//    `license`): tidak ada permukaan yang mewujudkannya di browser.
//  - `modelGateway` / `claudeAccounts` / `codexAccounts`.
//
// KEAMANAN. Di nodeterm `settings.json` memuat kredensial dan ditulis mode 0600. Di webterm
// settings melintas HTTP tanpa redaksi (`GET /api/settings`), jadi TIDAK ADA kunci yang boleh
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

export type { TerminalCursorStyle, TerminalCursorInactiveStyle, TerminalShortcutPolicy, TerminalGpuRendering, AppTheme } from './settings.terminal'
export { KEYBINDINGS_LIMITS, normalizeKeybindings } from './settings.keybindings'

// `CustomAgent` (BYO CLI) hidup di `customAgent.schema.ts`; `baseAgent` membuatnya MEWARISI
// kapabilitas harness builtin lewat `capabilityAgentId` (tanpa itu hanya spawn + judul terminal).
export type { CustomAgent, CustomAgentLaunch } from './customAgent.schema'

/** Full settings shape: terminal + agent slices (own files) plus the canvas/app keys below. */
export interface Settings extends TerminalSettings, AgentSettings {
  // --- Canvas ----------------------------------------------------------------------------------
  gridSize: number
  /** Snap saat drag: selagi ON, menggeser node membulatkan posisinya ke grid. */
  snapToGrid: boolean
  accent: string
  /** Ukuran default (px) untuk node terminal/agent BARU. Node yang sudah ada tetap memakai ukuran
   *  yang tersimpan bersamanya. */
  defaultNodeWidth: number
  defaultNodeHeight: number
  /** Gambar grid titik di canvas. Tampilan saja — snapping tidak berubah. */
  canvasDots: boolean
  /** Tampilan chrome APP (panel, header node, menu). `auto` (default) mengambilnya dari tema warna
   *  terminal, sehingga memilih tema terminal terang tidak menyisakan rangka hitam; `dark`/`light`
   *  memakunya. */
  appTheme: AppTheme
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
}

export const DEFAULT_SETTINGS: Settings = {
  fontSize: 13,
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  fontWeight: 400,
  fontWeightBold: 700,
  drawBoldTextInBrightColors: true,
  terminalLineHeight: 1,
  terminalLetterSpacing: 0,
  // Id tema adalah permukaan TERLIHAT (muncul di dropdown settings), bukan wire-protocol, jadi ia
  // memakai nama webterm — beda dari `nodeterm:too-large:` di fsLimits.ts yang memang protokol.
  terminalTheme: 'webterm-dark',
  terminalMinContrast: 1,
  cursorStyle: 'block',
  cursorInactiveStyle: 'outline',
  cursorBlink: true,
  terminalGpuRendering: 'auto',
  // Pertahankan tanda hubung, garis bawah, slash dan titik di dalam kata supaya identifier dan
  // path terseleksi utuh.
  terminalWordSeparator: " ()[]{}',\"",
  copyOnSelect: false,
  terminalMiddleClickPaste: false,
  terminalFontZoomKeys: true,
  terminalShortcutPolicy: 'app-first',
  defaultShell: '',
  // 256 KiB — persis `SCROLLBACK_BYTES` yang berjalan di server hari ini. Lihat doc kuncinya.
  scrollbackBytes: 256 * 1024,
  // 10.000 baris — angka yang dipakai xterm hari ini (dan clamp nodeterm), jadi mengangkatnya ke
  // settings tidak mengubah perilaku. Lihat doc kuncinya.
  scrollbackLines: 10_000,
  defaultAgent: 'claude',
  agentLaunchCommands: {},
  claudeLaunchProfiles: [],
  defaultClaudeProfileId: 'default',
  centralClaudeProfileId: '',
  customAgents: [],
  disabledAgents: [],
  claudePermissionMode: 'auto',
  hookReplyApprovals: true,
  gridSize: 24,
  snapToGrid: false,
  accent: '#0a84ff',
  defaultNodeWidth: 640,
  defaultNodeHeight: 440,
  canvasDots: true,
  appTheme: 'auto',
  canvasBackground: DEFAULT_CANVAS_BACKGROUND,
  canvasBackgroundByWorkspace: {},
  openMarkdownPreview: true,
  browserSearchEngine: 'google',
  keybindings: {},
  defaultProjectsFolder: '',
}


const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]

/**
 * Gabungkan objek settings yang mungkin parsial / dari versi lain di atas `DEFAULT_SETTINGS`.
 *
 * Shallow merge sudah cukup DI SINI, dan itu bukan kebetulan: satu-satunya kunci bernilai objek
 * (`agentLaunchCommands`) defaultnya `{}`, sehingga objek parsial yang tersimpan tidak bisa
 * menjatuhkan apa pun. nodeterm butuh deep-merge satu level justru karena objek bersarangnya
 * (`speech`, `modelGateway`) punya default BERISI — sebuah objek parsial dari file lama akan
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
  out.claudeLaunchProfiles = normalizeClaudeProfiles(src.claudeLaunchProfiles)
  // Nested object with a non-empty default: normalized field by field, never shallow-taken.
  out.canvasBackground = normalizeCanvasBackground(src.canvasBackground)
  out.canvasBackgroundByWorkspace = normalizeWorkspaceBackgrounds(src.canvasBackgroundByWorkspace)
  Object.assign(out, seedClaudeProfiles(src, out.agentLaunchCommands.claude))
  const agents = normalizeCustomAgents(src.customAgents, 'load')
  out.customAgents = agents.agents
  if (agents.errors.length) onInvalidAgents?.(agents.errors)
  return out
}
