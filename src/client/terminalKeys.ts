import type { Terminal } from '@xterm/xterm'
import type { TerminalShortcutPolicy } from '../shared/settings'

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

/* --- Platform ------------------------------------------------------------------------------- */

function platformString(): string {
  if (typeof navigator === 'undefined') return ''
  const withData = navigator as Navigator & { userAgentData?: { platform?: string } }
  return withData.userAgentData?.platform || navigator.platform || navigator.userAgent || ''
}

export function isMacPlatform(): boolean {
  return /mac|iphone|ipad/i.test(platformString())
}

export function isWindowsPlatform(): boolean {
  return /win/i.test(platformString())
}

/** Platform yang dipakai keputusan chord. Injectable supaya bisa dites tanpa `navigator`. */
export interface KeyPlatform {
  isMac: boolean
  isWindows: boolean
}

function hostPlatform(): KeyPlatform {
  return { isMac: isMacPlatform(), isWindows: isWindowsPlatform() }
}

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
 * ⌘/Ctrl + digit: satu-satunya famili chord yang `terminalShortcutPolicy` nodeterm benar-benar
 * gerbangi di dalam handler key terminal (`terminalShortcutPolicy() !== 'terminal-first' &&
 * liveProjectJumpTarget(e)` di TerminalNode.tsx:3484) — lompat ke workspace ke-N, plus ⌘0.
 *
 * Positional (`e.code`), bukan `e.key`, supaya AZERTY sepakat dengan canvas soal digit mana yang
 * ditekan. Shift ditolak: ⌘⇧1 chord lain.
 */
function isDigitChord(e: TerminalKeyEvent, isMac: boolean): boolean {
  if (e.type !== 'keydown' || e.altKey || e.shiftKey) return false
  const primary = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  return primary && /^Digit[0-9]$/.test(e.code)
}

/**
 * ⌘. (macOS) / Ctrl+. — satu-satunya chord app yang DIJAMIN lolos dari xterm ke window. Ia jalan
 * keluar dari clean view: di sana semua chrome disembunyikan, jadi keyboard adalah satu-satunya
 * jalan pulang, dan fokus hampir selalu di dalam xterm yang menelan hampir semua tombol.
 *
 * BUKAN Ctrl+\ — di terminal itu SIGQUIT dan akan membunuh proses foreground pengguna.
 *
 * Diekspor supaya listener window clean view memakai predikat yang SAMA; dua definisi chord yang
 * terpisah pasti menyimpang. Positional (`e.code`) seperti `isDigitChord`, modifier primer per
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
 * `policy` = `settings.terminalShortcutPolicy`. `app-first` (default) membiarkan chord app menyala
 * di atas xterm; `terminal-first` menyimpan setiap chord SELAIN milik terminal sendiri (copy,
 * Shift+Enter) untuk shell/TUI. Perbedaan yang teramati di webterm hari ini tepat satu famili —
 * ⌘/Ctrl+digit — karena webterm belum punya registry perintah; menambah chord app lain berarti
 * menambahnya ke `isDigitChord` bersama perintahnya, bukan melebarkan aturan ke bentuk chord lain
 * (Ctrl+Shift+<huruf> di shell polos masih berarti Ctrl+<huruf>, jadi memb-bubble-kan semuanya
 * akan mencuri tombol yang hari ini dipakai orang).
 *
 * `platform` di-inject hanya oleh test; runtime memakai `navigator`.
 */
export function terminalKeyAction(
  e: TerminalKeyEvent,
  policy: TerminalShortcutPolicy,
  platform: KeyPlatform = hostPlatform(),
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
  // SENGAJA tidak digerbangi `policy`, beda dari ⌘+digit: jalan keluar darurat tidak boleh bisa
  // dimatikan lewat setting, kalau tidak `terminal-first` mengunci pengguna di clean view tanpa
  // chrome untuk kembali.
  if (isCleanViewChord(e, platform.isMac)) return 'bubble'
  if (policy === 'app-first' && isDigitChord(e, platform.isMac)) return 'bubble'
  return 'pass'
}

/* --- Zoom font per-terminal ----------------------------------------------------------------- */

/** Rentang yang sama dengan yang diiklankan field font-size di Settings. */
export const TERMINAL_FONT_SIZE_MIN = 8
export const TERMINAL_FONT_SIZE_MAX = 28

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

/* --- Mouse ---------------------------------------------------------------------------------- */

/** Tombol mouse TENGAH, sebagaimana `MouseEvent.button` menomorinya (0 kiri, 1 tengah, 2 kanan). */
const MIDDLE_BUTTON = 1

/**
 * Haruskah event mouse ini ditelan sebelum xterm melihatnya? Murni, jadi aturannya bisa dipaku
 * tanpa DOM. Satu baris dan tetap layak dinamai, karena dua paruhnya mudah tertukar: `allow`
 * adalah setting pengguna "klik tengah boleh paste", jadi MENEKAN adalah yang terjadi saat OFF.
 */
export function suppressMiddleClickPaste(button: number, allow: boolean): boolean {
  return button === MIDDLE_BUTTON && !allow
}

/**
 * Hentikan klik tengah di dalam terminal mem-paste teks ke PTY.
 *
 * `preventDefault` SAJA tidak bisa bekerja: tidak ada aksi default browser di jalur ini — xterm
 * meneruskan LAPORAN MOUSE untuk tombol tengah ke PTY, dan yang mem-paste adalah sesuatu di
 * HILIRNYA (TUI yang membaca seleksi PRIMARY X). Jadi tuas yang bekerja adalah PROPAGASI: hentikan
 * event di fase CAPTURE pada host, sebelum listener xterm (terpasang di descendant) sempat jalan,
 * dan tak ada laporan yang diteruskan. Tidak ada hook yang lebih sempit — xterm tidak mengekspos
 * handler publik untuk tombol mouse (hanya `attachCustomKeyEventHandler` /
 * `attachCustomWheelEventHandler`).
 *
 * KONSEKUENSI YANG HARUS DIMILIKI SETTING INI: dengan setting OFF, tombol tengah sepenuhnya INERT
 * di dalam terminal — bukan "browser tidak mem-paste", tapi "klik tengah tidak melakukan apa pun
 * di sini". Itu perilaku yang diminta; salinan teks Settings harus mengatakan hal yang sama.
 *
 * `allow` dibaca pada WAKTU EVENT, bukan waktu attach, jadi membalik setting berlaku pada klik
 * berikutnya alih-alih pada terminal berikutnya.
 */
export function guardMiddleClickPaste(host: HTMLElement, allow: () => boolean): () => void {
  const onEvent = (e: MouseEvent): void => {
    if (!suppressMiddleClickPaste(e.button, allow())) return
    e.preventDefault()
    e.stopPropagation()
    // Membungkam juga listener lain di host itu sendiri, bukan hanya descendant.
    e.stopImmediatePropagation()
  }
  host.addEventListener('mousedown', onEvent, true)
  host.addEventListener('mouseup', onEvent, true)
  host.addEventListener('auxclick', onEvent, true)
  return () => {
    host.removeEventListener('mousedown', onEvent, true)
    host.removeEventListener('mouseup', onEvent, true)
    host.removeEventListener('auxclick', onEvent, true)
  }
}

/** Potongan `Terminal` xterm yang dibaca copy-on-select — sempit, supaya test tak butuh xterm. */
export interface CopyOnSelectTerminal {
  readonly element: HTMLElement | undefined
  readonly modes: { readonly mouseTrackingMode: Terminal['modes']['mouseTrackingMode'] }
  readonly options: { readonly macOptionClickForcesSelection?: boolean }
  hasSelection(): boolean
  getSelection(): string
}

/**
 * Apakah SelectionService xterm mengambil mousedown ini? Mencerminkan `handleMouseDown` +
 * `shouldForceSelection` xterm: tombol primer saja; selalu saat tidak ada app yang melacak mouse
 * (service-nya aktif); selain itu hanya saat dipaksa — Option (dengan
 * `macOptionClickForcesSelection`) di macOS, Shift di tempat lain.
 */
export function xtermOwnsMouseDown(
  e: Pick<MouseEvent, 'button' | 'altKey' | 'shiftKey'>,
  mouseTrackingMode: CopyOnSelectTerminal['modes']['mouseTrackingMode'],
  platform: { isMac: boolean; optionForces: boolean },
): boolean {
  if (e.button !== 0) return false
  if (mouseTrackingMode === 'none') return true
  return platform.isMac ? e.altKey && platform.optionForces : e.shiftKey
}

export interface CopyOnSelectDeps {
  /** Setting live. Dibaca pada waktu event, tidak pernah ditangkap closure. */
  enabled: () => boolean
  /** Menulis clipboard sistem. */
  write: (text: string) => void
  isMac?: boolean
}

/**
 * Pasang copy-on-select ke terminal yang sudah DIBUKA. Mengembalikan disposer.
 *
 * SELEKSI MANA YANG DIHITUNG — dan kenapa ini BUKAN subscription `onSelectionChange`. Event itu
 * juga menyala untuk seleksi PROGRAMATIK (addon search memanggil `Terminal.select()` untuk setiap
 * hit yang dilangkahi pengguna) dan saat seleksi dihapus. Jadi pemicunya adalah GESTUR-nya: tekan
 * tombol primer di dalam `term.element` yang diambil SelectionService xterm (`xtermOwnsMouseDown`),
 * diikuti rilis DI MANA PUN di window — drag sangat sering melewati batas node, dan xterm sendiri
 * mendengarkan rilis itu di document. Seleksi kata/baris dari double/triple-click adalah gestur
 * yang sama dengan `detail` 2/3 dan ikut tercakup gratis.
 *
 * URUTAN: pada mousedown, xterm menambahkan listener `mouseup` fase-bubble di DOCUMENT dan
 * memfinalkan seleksi di sana. Listener rilis kita ada di WINDOW fase CAPTURE (supaya tak ada yang
 * di bawahnya bisa menghentikannya), jadi ia jalan SEBELUM milik xterm. Pembacaan karenanya
 * ditunda dengan macrotask (`setTimeout 0`) — BUKAN `queueMicrotask`: untuk event pengguna nyata,
 * checkpoint microtask jalan di antara callback listener, yang masih sebelum listener document
 * xterm.
 *
 * TIDAK PERNAH MENULIS KOSONG: klik biasa menghapus seleksi; menulis `''` akan mengosongkan
 * clipboard.
 */
export function attachCopyOnSelect(term: CopyOnSelectTerminal, deps: CopyOnSelectDeps): () => void {
  const element = term.element
  if (!element) return () => {}
  const win = element.ownerDocument.defaultView ?? window
  const isMac = deps.isMac ?? isMacPlatform()
  let pendingUp: ((e: MouseEvent) => void) | null = null
  let readTimer: ReturnType<typeof setTimeout> | null = null

  // Mengakhiri gestur yang ter-arm TANPA menulis. Gestur yang kehilangan rilisnya dan listener-nya
  // tetap hidup akan menyalin apa pun yang terseleksi saat rilis BERIKUTNYA datang — highlight
  // basi atau hit pencarian. Tiga cara rilis bisa hilang: blur (tombol ditahan, dilepas di app
  // lain), mousedown lain di window, dan dispose.
  const disarm = (): void => {
    if (pendingUp) win.removeEventListener('mouseup', pendingUp, true)
    pendingUp = null
    win.removeEventListener('blur', disarm)
    win.removeEventListener('mousedown', disarm, true)
  }

  const clearPending = (): void => {
    disarm()
    if (readTimer !== null) clearTimeout(readTimer)
    readTimer = null
  }

  const onDown = (e: MouseEvent): void => {
    if (!deps.enabled()) return
    const owned = xtermOwnsMouseDown(e, term.modes.mouseTrackingMode, {
      isMac,
      optionForces: term.options.macOptionClickForcesSelection === true,
    })
    if (!owned) return
    clearPending()
    const onUp = (up: MouseEvent): void => {
      // Hanya rilis PRIMER yang menyelesaikan gestur: rilis kanan/tengah di tengah drag akan
      // menyalin seleksi separuh jalan dan menjatuhkan yang sebenarnya.
      if (up.button !== 0) return
      disarm()
      readTimer = setTimeout(() => {
        readTimer = null
        if (!deps.enabled() || !term.hasSelection()) return
        const text = term.getSelection()
        if (text) deps.write(text)
      }, 0)
    }
    pendingUp = onUp
    win.addEventListener('mouseup', onUp, true)
    win.addEventListener('blur', disarm)
    // Ditambahkan selagi fase capture ELEMENT dari tekanan INI, jadi ia tidak bisa menyala untuk
    // tekanan ini: fase capture window sudah terlewat.
    win.addEventListener('mousedown', disarm, true)
  }

  // Fase capture karena xterm memanggil `stopPropagation` pada mousedown yang dipaksa, dari
  // listener bubble-nya di elemen yang sama.
  element.addEventListener('mousedown', onDown, true)
  return () => {
    element.removeEventListener('mousedown', onDown, true)
    clearPending()
  }
}
