import type { TerminalShortcutPolicy } from '../shared/settings'
import { SETTING_RANGES } from '../shared/settings.ranges'
import { eventChord, listCommands, normalizeChord } from './commandRegistry'
import { keybindingOverrides, type KeybindingOverrides } from './keybindings.store'
import { isAppChord } from './keybindings.resolve'
import { hostPlatform, isMacPlatform, type KeyPlatform } from './terminalKeys.platform'

export { isLinuxPlatform, isMacPlatform, isWindowsPlatform, type KeyPlatform } from './terminalKeys.platform'
export * from './terminalKeys.mouse'

/**
 * Keputusan MURNI untuk gestur input terminal — keyboard dan mouse — plus dua pemasang listener
 * DOM yang memakainya. Port dari nodeterm `terminal-config.ts` (chord copy/paste/Shift+Enter),
 * `terminal-font-zoom.ts`, `copy-on-select.ts` dan `middle-click.ts`.
 *
 * Satu modul, bukan empat, karena webterm hanya punya SATU call site xterm (`TerminalCore`) —
 * nodeterm punya tiga (canvas node, modal kanban, preview settings) dan memecahnya supaya ketiganya
 * tidak menyimpang. Semua yang perlu dites di sini murni dan tidak menyentuh DOM saat diimpor,
 * karena vitest webterm jalan di environment node tanpa jsdom.
 */


/* --- Chord keyboard ------------------------------------------------------------------------- */

/** Subset `KeyboardEvent` yang dilihat keputusan chord (jadi test tak butuh DOM). */
export interface TerminalKeyEvent {
  type: string
  key: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/**
 * Shift+Enter → newline, bukan submit. Keymap default xterm mengirim `\r` polos untuk Shift+Enter,
 * yang dibaca CLI agent (Claude Code, Codex) sebagai "submit". Kita petakan ke ESC+CR (`\x1b\r`):
 * CLI agent memperlakukannya sebagai "sisipkan newline" — binding Alt/Option+Enter mereka. CSI-u
 * (`\x1b[13;2u`) ditolak nodeterm karena hanya lolos tmux dengan `extended-keys`; webterm tidak
 * punya tmux, tapi tetap ESC+CR supaya byte yang sampai ke agent identik dengan nodeterm.
 * Dikirim di SEMUA terminal, agent atau bukan — di shell polos ESC+CR paling buruk accept-line.
 */
export const SHIFT_ENTER_SEQ = '\x1b\r'

/**
 * Option+←/→ di macOS → `ESC b` / `ESC f` (word-back / word-forward), seperti Terminal.app dan
 * iTerm. xterm 6.0.0 mengirim CSI mentah `ESC[1;3D` / `ESC[1;3C`; readline /bin/bash 3.2 tak punya
 * binding-nya, jadi ia memakan `ESC [ 1` lalu menge-echo sisanya (`;3C`). `ESC b/f` di-bind readline
 * dan zsh. Hanya Alt murni: modifier lain tetap lewat ke xterm.
 */
export function optionArrowSeq(
  e: TerminalKeyEvent,
  isMac: boolean = isMacPlatform(),
): string | null {
  if (!isMac || e.type !== 'keydown' || !e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return null
  if (e.key === 'ArrowLeft') return '\x1bb'
  if (e.key === 'ArrowRight') return '\x1bf'
  return null
}

/**
 * True untuk keydown yang harus menyalin seleksi terminal: ⌘C (mac), Ctrl+Shift+C (Linux, Windows)
 * dan Ctrl+Insert (binding terminal tradisional). Ctrl+C polos SENGAJA bukan salah satunya — ia
 * harus tetap sampai ke PTY sebagai SIGINT.
 *
 * Hurufnya dicocokkan pada key yang tercetak (`e.key`, jadi Dvorak/AZERTY mengikuti huruf yang
 * benar-benar ditekan) ATAU pada posisi fisik `KeyC` (`e.code`) — di layout non-Latin (Cyrillic
 * 'с', Greek 'ψ') `e.key` tidak pernah 'c', dan tanpa fallback itu seleksi xterm tidak punya copy
 * via keyboard sama sekali (menu Edit browser hanya menyalin seleksi DOM, bukan seleksi xterm).
 *
 * ⌘⇧C sengaja ikut diizinkan: tak ada yang lain mengikatnya dan ia nyaris-sama dengan ⌘C. Kombo
 * AltGr (yang melaporkan ctrl+alt) tidak pernah menyalin.
 */
export function isCopyShortcut(e: TerminalKeyEvent): boolean {
  if (e.type !== 'keydown') return false
  const insert = e.key === 'Insert' || e.code === 'Insert'
  const letterC = e.key.toLowerCase() === 'c' || e.code === 'KeyC'
  if (!insert && !letterC) return false
  // Ctrl+Insert = copy (Shift+Insert = paste, bukan milik kita). Tanpa meta/alt.
  if (insert) return e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
  const cmdC = e.metaKey && !e.ctrlKey && !e.altKey
  const ctrlShiftC = e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey
  return cmdC || ctrlShiftC
}

/**
 * Chord paste yang keymap xterm sendiri akan MEMAKAN — Ctrl+V, dan hanya di Windows.
 *
 * Kita tidak mem-paste sendiri: platform sudah melakukannya. Yang dilakukan keputusan ini hanyalah
 * menghentikan xterm MEMBATALKAN keydown-nya, supaya event `paste` biasa sampai ke textarea
 * pembantu xterm (yang memasang framing bracketed-paste lalu menulis ke PTY) seperti ⌘V di macOS.
 *
 * Diukur terhadap `evaluateKeyboardEvent` xterm: **Ctrl+V** dipetakan ke `\x16` (SYN) dengan
 * `cancel: true`, jadi xterm memanggil `preventDefault()` — yang menekan perintah paste browser.
 * Hasilnya: tak ada yang di-paste, tak ada yang diketik, tak ada error. **Ctrl+Shift+V** dan
 * **Shift+Insert** tidak menghasilkan key dan tidak dibatalkan, jadi xterm sudah melewatkannya.
 *
 * **Windows saja, sengaja.** Di macOS ⌘V adalah chord paste dan Ctrl+V harus tetap `\x16`; di Linux
 * konvensi terminalnya Ctrl+Shift+V, dan Ctrl+V adalah tombol yang betul-betul dikirim orang
 * (visual-block vim, literal-next readline).
 */
export function isPasteShortcut(e: TerminalKeyEvent, isWindows: boolean): boolean {
  if (!isWindows || e.type !== 'keydown') return false
  if (e.key.toLowerCase() !== 'v' && e.code !== 'KeyV') return false
  // AltGr melaporkan ctrl+alt, dan Ctrl+Shift+V bukan milik kita (xterm sudah melewatkannya).
  return e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey
}

/**
 * ⌘. (macOS) / Ctrl+. — satu-satunya chord app yang DIJAMIN lolos dari xterm ke window. Ia jalan
 * keluar dari clean view: di sana semua chrome disembunyikan, jadi keyboard adalah satu-satunya
 * jalan pulang, dan fokus hampir selalu di dalam xterm yang menelan hampir semua tombol.
 *
 * BUKAN Ctrl+\ — di terminal itu SIGQUIT dan akan membunuh proses foreground pengguna.
 *
 * Diekspor supaya listener window clean view memakai predikat yang SAMA; dua definisi chord yang
 * terpisah pasti menyimpang. Positional (`e.code`), modifier primer per
 * platform saja (Ctrl+. di macOS adalah tombol yang dikirim orang ke shell), Shift/Alt ditolak
 * supaya aturannya tidak melebar ke bentuk chord lain.
 */
export function isCleanViewChord(e: TerminalKeyEvent, isMac: boolean): boolean {
  if (e.type !== 'keydown' || e.altKey || e.shiftKey || e.code !== 'Period') return false
  return isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
}

/**
 * Apa yang harus dilakukan keydown di dalam terminal:
 * - `copy`        — chord copy: telan tombolnya, dan salin seleksi KALAU ada. Menelan saat tidak
 *   ada seleksi itu kritis untuk Ctrl+Shift+C: melewatkannya berarti xterm memetakan ctrl+c ke
 *   `\x03` dan mem-SIGINT proses foreground. Kita mengiklankan chord itu sebagai "copy", jadi
 *   menekannya tepat setelah klik yang menghapus seleksi tidak boleh pernah membunuh proses.
 * - `shift-enter` — kirim `SHIFT_ENTER_SEQ` ke PTY.
 * - `bubble`      — app yang memiliki chord ini: kembalikan `false` dari handler xterm (supaya
 *   keymap xterm dilewati dan tidak menulis control byte) TANPA `preventDefault` — event yang
 *   ditandai `defaultPrevented` membuat dispatcher window mundur, jadi bubble yang di-prevent
 *   justru membunuh dispatch yang ia ada untuk dicapai.
 * - `native`      — mekanika sama dengan `bubble`, pemilik berbeda: perintah editing browser
 *   (Ctrl+V Windows). Dua nilai, bukan satu cabang, karena alasannya berbeda.
 * - `pass`        — bukan milik kita: xterm menanganinya seperti biasa.
 */
export type TerminalKeyAction = 'pass' | 'bubble' | 'native' | 'copy' | 'shift-enter'

/**
 * Keputusan tunggal untuk `attachCustomKeyEventHandler`.
 *
 * `policy` = `settings.terminalShortcutPolicy`. Chord yang di-bubble-kan tidak lagi daftar tetap:
 * `isAppChord` membaca chord EFEKTIF setiap perintah global di registry (`list` + `overrides`),
 * jadi rebinding langsung berlaku di dalam terminal — chord lama kembali ke shell, chord baru ke
 * app. `app-first` membubble-kan semua chord yang terikat kecuali Ctrl+huruf polos di luar mac
 * (tombol readline) yang tidak diikat pengguna sendiri; `terminal-first` hanya jalan keluar darurat.
 *
 * `platform`, `list`, `overrides` di-inject oleh test; runtime memakai `navigator` dan registry.
 */
export function terminalKeyAction(
  e: TerminalKeyEvent,
  policy: TerminalShortcutPolicy,
  platform: KeyPlatform = hostPlatform(),
  list = listCommands(),
  overrides: KeybindingOverrides = keybindingOverrides(),
): TerminalKeyAction {
  if (
    e.type === 'keydown' &&
    e.key === 'Enter' &&
    e.shiftKey &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.altKey
  ) {
    return 'shift-enter'
  }
  // Chord terminal sendiri menang lebih dulu, apa pun policy-nya — itulah arti "kecuali milik
  // terminal sendiri" di `terminal-first`.
  if (isCopyShortcut(e)) return 'copy'
  if (isPasteShortcut(e, platform.isWindows)) return 'native'
  // SENGAJA tidak bergantung pada registry maupun `policy`: jalan keluar darurat tidak boleh bisa
  // dimatikan, kalau tidak `terminal-first` mengunci pengguna di clean view tanpa chrome untuk kembali.
  if (isCleanViewChord(e, platform.isMac)) return 'bubble'
  if (isAppChord(e, policy, list, overrides, platform)) return 'bubble'
  return 'pass'
}

/* --- Zoom font per-terminal ----------------------------------------------------------------- */

/** Batas zoom = batas field font-size di Settings; keduanya membaca tabel yang sama. */
export const TERMINAL_FONT_SIZE_MIN = SETTING_RANGES.fontSize.min
export const TERMINAL_FONT_SIZE_MAX = SETTING_RANGES.fontSize.max

export type TerminalFontZoomAction = 'increase' | 'decrease' | 'reset'

/**
 * MURNI, bentuk tombol saja. ⌘+/⌘− membesarkan dan mengecilkan font terminal yang FOKUS, ⌘0
 * mengembalikannya ke ukuran global — yang dimaksud setiap emulator terminal (iTerm2,
 * Terminal.app, Windows Terminal, terminal terintegrasi VS Code) dengan tombol-tombol itu.
 *
 * - **Modifier primer per platform, tepat salah satu**: ⌘ di macOS, Ctrl di tempat lain. Chord ini
 *   menyala selagi pengguna MENGETIK di shell, dan di macOS Ctrl+−/Ctrl+= adalah tombol terminal
 *   (^_ adalah undo readline) yang harus tetap sampai ke PTY.
 * - **+ dan − dicocokkan pada KARAKTER** (`e.key`), dengan kode numpad sebagai fallback: tombol
 *   yang ditekan untuk "lebih besar" adalah yang berlabel +, yang di layout Jerman tombol sendiri
 *   dan di US adalah ⇧= — jadi Shift tidak dibatasi untuk dua ini.
 * - **0 dicocokkan pada tombol fisik** (`e.code`); ⌘⇧0 chord lain. Numpad 0 hanya dihitung saat ia
 *   mengetik nol (Num Lock on), karena dengan Num Lock off ia Insert — dan Ctrl+Insert adalah
 *   chord COPY.
 * - Alt ditolak (AltGr melaporkan ctrl+alt di luar mac dan harus tetap mengetik karakternya).
 * - Auto-repeat DITERIMA: tak ada animasi di sini, dan menahan ⌘+ untuk terus membesar itu wajar.
 */
export function terminalFontZoomChord(
  e: TerminalKeyEvent,
  isMac: boolean = isMacPlatform(),
): TerminalFontZoomAction | null {
  if (e.type !== 'keydown' || e.altKey) return null
  const primary = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!primary) return null
  if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') return 'increase'
  if (e.key === '-' || e.code === 'NumpadSubtract') return 'decrease'
  if (!e.shiftKey && (e.code === 'Digit0' || (e.code === 'Numpad0' && e.key === '0'))) return 'reset'
  return null
}

const ZOOM_COMMANDS: Record<TerminalFontZoomAction, string> = {
  increase: 'terminal.fontZoomIn',
  decrease: 'terminal.fontZoomOut',
  reset: 'terminal.fontZoomReset',
}

/**
 * Aksi zoom untuk keydown, mengikuti registry: perintah yang di-rebind pengguna dicocokkan pada
 * chord barunya (`null` mematikannya); yang tidak, pada bentuk default `terminalFontZoomChord`
 * (yang lebih luas dari satu chord: ⇧=, numpad).
 */
export function terminalZoomAction(
  e: TerminalKeyEvent,
  overrides: KeybindingOverrides = keybindingOverrides(),
  isMac: boolean = isMacPlatform(),
): TerminalFontZoomAction | null {
  if (e.type !== 'keydown') return null
  const chord = eventChord(e, isMac)
  for (const [action, id] of Object.entries(ZOOM_COMMANDS) as [TerminalFontZoomAction, string][]) {
    const k = overrides[id]
    if (k && chord && normalizeChord(k, isMac) === chord) return action
  }
  const def = terminalFontZoomChord(e, isMac)
  return def && !Object.hasOwn(overrides, ZOOM_COMMANDS[def]) ? def : null
}

/**
 * MURNI. Override ukuran font BARU terminal setelah `action` (`undefined` = tanpa override, ikut
 * ukuran global).
 *
 * - Melangkah 1 dari ukuran EFEKTIF.
 * - Mendarat kembali di ukuran global menghapus override alih-alih menyimpan salinannya, supaya
 *   terminal yang dinaikkan lalu diturunkan kembali mengikuti perubahan global berikutnya.
 * - Hasil di-clamp ke rentang Settings, tapi clamp hanya boleh menggeser ukuran ke ARAH yang
 *   diminta: di batas, langkahnya no-op, dan ⌘+ tidak pernah bisa MENGECILKAN terminal yang
 *   ukuran globalnya diedit tangan di atas maksimum.
 * - `reset` selalu menghapus.
 */
export function nextTerminalFontSize(
  action: TerminalFontZoomAction,
  override: number | undefined,
  global: number,
): number | undefined {
  if (action === 'reset') return undefined
  const base = override ?? global
  const grow = action === 'increase'
  const target = Math.min(
    TERMINAL_FONT_SIZE_MAX,
    Math.max(TERMINAL_FONT_SIZE_MIN, base + (grow ? 1 : -1)),
  )
  if (grow ? target <= base : target >= base) return override
  return target === global ? undefined : target
}

