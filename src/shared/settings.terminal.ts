// Terminal (xterm) slice of `Settings`: visual, interaction, shell & buffer keys. Merged into
// `Settings` in `settings.ts`; defaults live in `DEFAULT_SETTINGS` there.

export type TerminalCursorStyle = 'block' | 'bar' | 'underline'
export type TerminalShortcutPolicy = 'app-first' | 'terminal-first'
/** `auto` = System: follows the OS light/dark mode (`prefers-color-scheme`). */
export type AppTheme = 'auto' | 'dark' | 'light'

export interface TerminalSettings {
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
  cursorBlink: boolean

  // --- Interaksi -------------------------------------------------------------------------------
  /** Karakter yang mengakhiri kata saat seleksi double-click xterm. */
  terminalWordSeparator: string
  /** Salin seleksi MOUSE yang selesai ke clipboard sistem. OFF secara default: mengganti isi
   *  clipboard tanpa diminta adalah kejutan yang layak dipilih sendiri. */
  copyOnSelect: boolean
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
   * Pilihan satuan ini disengaja dan perlu dicatat: menyimpan dalam BARIS cocok untuk history tmux, tapi
   * di sini yang membatasi adalah ring buffer byte mentah PTY di `src/server/sessions.ts`
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
}
