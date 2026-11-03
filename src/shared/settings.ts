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

import { normalizeCustomAgents, type CustomAgent, type CustomAgentError } from './customAgent.schema'
import { clampSetting, SETTING_RANGES, type RangedKey } from './settings.ranges'
import type { AgentId, AgentPermissionMode, BuiltinAgentId } from './workspace'

export type TerminalCursorStyle = 'block' | 'bar' | 'underline'
export type TerminalCursorInactiveStyle = TerminalCursorStyle | 'outline' | 'none'
export type TerminalShortcutPolicy = 'app-first' | 'terminal-first'
/**
 * Rendering terminal lewat GPU. `off` mengarahkan setiap terminal ke renderer DOM xterm. `auto`
 * (default) = satu konteks WebGL PER TERMINAL, dengan fallback otomatis ke DOM bila konteksnya
 * gagal dibuat atau hilang.
 *
 * Nilai `'shared'` milik nodeterm TIDAK disertakan: ia renderer glyphgrid bespoke (satu konteks
 * canvas-wide) yang webterm tidak punya. Menyertakan nilainya berarti menawarkan mode yang tidak
 * ada implementasinya.
 */
export type TerminalGpuRendering = 'off' | 'auto'
export type AppTheme = 'auto' | 'dark' | 'light'

// `CustomAgent` (BYO CLI) hidup di `customAgent.schema.ts`; `baseAgent` membuatnya MEWARISI
// kapabilitas harness builtin lewat `capabilityAgentId` (tanpa itu hanya spawn + judul terminal).
export type { CustomAgent, CustomAgentLaunch } from './customAgent.schema'

export interface Settings {
  // --- Visual xterm (live-apply: perubahan langsung diterapkan ke terminal yang terbuka) -------
  fontSize: number
  fontFamily: string
  /** Bobot teks normal. Default xterm sendiri `normal` (400). */
  fontWeight: number
  /** Bobot teks BOLD. Default xterm sendiri `bold` (700). Menurunkannya adalah cara menjaga bold
   *  tetap terbaca pada font tipis yang merender 700 jadi gumpalan. */
  fontWeightBold: number
  /** Render teks bold dengan warna BRIGHT dari palet (default xterm, dan konvensi terminal
   *  historis). Off membuat bold murni soal bobot, sehingga warna tetap berarti apa yang program
   *  maksudkan. */
  drawBoldTextInBrightColors: boolean
  /** Tinggi baris sebagai kelipatan ukuran font (1 = default xterm, tanpa leading tambahan). */
  terminalLineHeight: number
  /** Spasi horizontal ekstra antar sel, dalam piksel CSS (0 = default xterm). */
  terminalLetterSpacing: number
  /** Skema warna terminal — id dari tabel tema client. Resolusi harus toleran (nilai bisa
   *  diedit tangan): id tak dikenal jatuh ke tema default. */
  terminalTheme: string
  /** Rasio kontras minimum foreground/background, 1–21. 1 (default xterm) mematikan penyesuaian
   *  sepenuhnya; 4.5 = WCAG AA, 7 = AAA, 21 memaksa hitam atau putih. Ada biaya kerja per sel di
   *  renderer, jadi tetap mati kecuali diminta. */
  terminalMinContrast: number
  cursorStyle: TerminalCursorStyle
  /** Bentuk kursor saat terminal TIDAK fokus. `outline` (default xterm sendiri) itulah yang
   *  memberi tahu sekilas terminal mana di antara satu canvas penuh yang menerima ketikan. */
  cursorInactiveStyle: TerminalCursorInactiveStyle
  cursorBlink: boolean
  terminalGpuRendering: TerminalGpuRendering

  // --- Interaksi -------------------------------------------------------------------------------
  /** Karakter yang mengakhiri kata saat seleksi double-click xterm. */
  terminalWordSeparator: string
  /** Salin seleksi MOUSE yang selesai ke clipboard sistem. OFF secara default: mengganti isi
   *  clipboard tanpa diminta adalah kejutan yang layak dipilih sendiri. */
  copyOnSelect: boolean
  /** Izinkan KLIK TENGAH di dalam terminal mem-paste (praktisnya Linux). OFF secara default, dan
   *  OFF berarti tombol tengah sepenuhnya INERT di dalam terminal. Defaultnya mati karena paste
   *  ini paling keras terasa di dalam TUI agent: satu klik nyasar menjatuhkan apa pun yang terakhir
   *  diseleksi ke prompt agent yang sedang hidup. */
  terminalMiddleClickPaste: boolean
  /** ⌘+ / ⌘− / ⌘0 mengubah ukuran font terminal yang FOKUS. ON secara default. Di luar macOS
   *  chord-nya Ctrl+= / Ctrl+− / Ctrl+0 — Ctrl+− biasanya undo readline, jadi matikan bila bentrok. */
  terminalFontZoomKeys: boolean
  /** Siapa yang menang selagi terminal memegang fokus keyboard: `app-first` (default) membiarkan
   *  perintah app menyala di atas xterm; `terminal-first` menyimpan setiap chord selain milik
   *  terminal sendiri (find, copy) untuk shell/TUI. */
  terminalShortcutPolicy: TerminalShortcutPolicy

  // --- Shell & buffer --------------------------------------------------------------------------
  /** String kosong = pakai shell default sistem. */
  defaultShell: string
  /**
   * Scrollback dalam BYTE, bukan baris.
   *
   * Pilihan satuan ini disengaja dan perlu dicatat: nodeterm menyimpan `tmuxScrollback: 50000`
   * dalam BARIS karena yang membatasi di sana adalah history tmux. webterm tidak punya tmux —
   * yang membatasi adalah ring buffer byte mentah PTY di `src/server/sessions.ts`
   * (`SCROLLBACK_BYTES`), satu-satunya konsumen nyata. Satuannya karena itu byte, dan defaultnya
   * 256 KiB = nilai konstanta yang berjalan hari ini, jadi mengangkatnya ke settings tidak
   * mengubah perilaku apa pun.
   *
   * Batas sisi client punya kunci TERPISAH, `scrollbackLines`. Jangan diam-diam mengubah arti
   * kunci ini menjadi baris.
   */
  scrollbackBytes: number
  /**
   * Scrollback xterm sisi CLIENT dalam BARIS — kunci terpisah dari `scrollbackBytes` karena
   * satuan dan konsumennya berbeda: yang ini mendarat di opsi `scrollback` xterm (xterm menghitung
   * baris grid), sedangkan `scrollbackBytes` membatasi ring buffer byte mentah PTY di server.
   * Satu nilai tidak bisa melayani keduanya — byte yang dipakai sebagai baris memberi xterm
   * ratusan ribu baris buffer per node, dan biayanya per node (`cols × 12 B` per baris) sementara
   * satu canvas memuat banyak node.
   */
  scrollbackLines: number

  // --- Agent -----------------------------------------------------------------------------------
  /** Agent yang diluncurkan tombol quick-add. */
  defaultAgent: AgentId
  /** Override perintah peluncuran per agent builtin. Nilainya mengganti nama CLI polos di mana
   *  pun baris peluncuran dibangun — sesi baru, relaunch, restart in-place — dengan flag yang biasa
   *  (`--resume`, prompt) ditempelkan setelahnya, sehingga skrip wrapper yang memilih akun ikut
   *  berjalan. Kosong/absen = default builtin. Hanya builtin: agent custom sudah punya
   *  `launchCmd`-nya sendiri. */
  agentLaunchCommands: Partial<Record<BuiltinAgentId, string>>
  customAgents: CustomAgent[]
  /** Id agent yang disembunyikan dari menu Add. */
  disabledAgents: AgentId[]
  /** Mode permission yang dipakai sesi Claude saat START — dikirim sebagai `--permission-mode`
   *  saat peluncuran; Shift+Tab tetap bisa memutar mode saat runtime. */
  claudePermissionMode: AgentPermissionMode
  /** Persetujuan hook yang deterministik: saat on (default), sesi Claude diluncurkan dengan
   *  `NODETERM_PERM_WAIT_SECS` — hook permission menahan sejenak menunggu Approve/Deny dari canvas
   *  sebelum jatuh ke prompt interaktif biasa. Off ⇒ env var absen ⇒ perilaku lama persis. */
  hookReplyApprovals: boolean

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

  // --- Preview ---------------------------------------------------------------------------------
  /** Buka file Markdown (.md, .markdown, …) dalam preview terender alih-alih editor kode. Hanya
   *  menentukan tampilan saat node editor DIBUKA — toggle Preview/Edit node tetap bisa berpindah
   *  dua arah. */
  openMarkdownPreview: boolean
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
  openMarkdownPreview: true,
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
  const agents = normalizeCustomAgents(src.customAgents, 'load')
  out.customAgents = agents.agents
  if (agents.errors.length) onInvalidAgents?.(agents.errors)
  return out
}
