import type { ITheme } from '@xterm/xterm'

/**
 * Skema warna terminal. Port dari nodeterm `src/renderer/terminal/themes.ts`.
 *
 * Data murni + satu resolver, SENGAJA tanpa import runtime xterm (`ITheme` type-only), supaya
 * modul ini ikut termuat di test node-env. Segala yang mengubah tema jadi opsi xterm ada di
 * `terminalConfig.ts`.
 *
 * Kontrak yang membuat ini aman: **`webterm-dark` harus merender persis apa yang dirender
 * TerminalCore sebelum tema ada** — dulu ia hardcode `{ background: '#1e1e1e', foreground: ... }`
 * dan membiarkan xterm mengisi sisanya, jadi tema default membawa dua warna itu plus palet ANSI
 * default xterm (Tango) yang ditulis eksplisit. `themes.test.ts` memakunya: "memperbaiki" ke-18
 * nilai itu diam-diam mengecat ulang terminal setiap pengguna yang sudah ada.
 *
 * Id tema nodeterm yang mengandung `nodeterm` di-rename jadi `webterm` (`nodeterm-dark` →
 * `webterm-dark`, `nodeterm-light` → `webterm-light`): id tema muncul di dropdown settings, jadi
 * ia permukaan TERLIHAT, bukan wire-protocol. Id tema pihak ketiga (dracula, nord, …) tidak
 * disentuh — itu nama skema warna milik orang lain.
 */

export interface TerminalTheme {
  id: string
  label: string
  /** Apakah skemanya gelap — mengelompokkan picker, dan ini yang perlu dideklarasikan tema terang
   *  supaya chrome node di sekelilingnya tetap terbaca di atasnya. */
  dark: boolean
  theme: ITheme
}

export const DEFAULT_TERMINAL_THEME_ID = 'webterm-dark'

export const TERMINAL_THEMES: readonly TerminalTheme[] = [
  {
    id: 'webterm-dark',
    label: 'webterm Dark',
    dark: true,
    theme: {
      background: '#1e1e1e',
      foreground: '#e6e6e6',
      cursor: '#ffffff',
      cursorAccent: '#1e1e1e',
      selectionBackground: '#ffffff4d',
      // Palet default built-in xterm (Tango) — lihat komentar modul.
      black: '#2e3436',
      red: '#cc0000',
      green: '#4e9a06',
      yellow: '#c4a000',
      blue: '#3465a4',
      magenta: '#75507b',
      cyan: '#06989a',
      white: '#d3d7cf',
      brightBlack: '#555753',
      brightRed: '#ef2929',
      brightGreen: '#8ae234',
      brightYellow: '#fce94f',
      brightBlue: '#729fcf',
      brightMagenta: '#ad7fa8',
      brightCyan: '#34e2e2',
      brightWhite: '#eeeeec',
    },
  },
  {
    id: 'dracula',
    label: 'Dracula',
    dark: true,
    theme: {
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      cursorAccent: '#282a36',
      selectionBackground: '#44475a',
      black: '#21222c',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#f8f8f2',
      brightBlack: '#6272a4',
      brightRed: '#ff6e6e',
      brightGreen: '#69ff94',
      brightYellow: '#ffffa5',
      brightBlue: '#d6acff',
      brightMagenta: '#ff92df',
      brightCyan: '#a4ffff',
      brightWhite: '#ffffff',
    },
  },
  {
    id: 'tokyo-night',
    label: 'Tokyo Night',
    dark: true,
    theme: {
      background: '#1a1b26',
      foreground: '#c0caf5',
      cursor: '#c0caf5',
      cursorAccent: '#1a1b26',
      selectionBackground: '#33467c',
      black: '#15161e',
      red: '#f7768e',
      green: '#9ece6a',
      yellow: '#e0af68',
      blue: '#7aa2f7',
      magenta: '#bb9af7',
      cyan: '#7dcfff',
      white: '#a9b1d6',
      brightBlack: '#414868',
      brightRed: '#ff7a93',
      brightGreen: '#b9f27c',
      brightYellow: '#ff9e64',
      brightBlue: '#7da6ff',
      brightMagenta: '#bb9af7',
      brightCyan: '#0db9d7',
      brightWhite: '#c0caf5',
    },
  },
  {
    id: 'catppuccin-mocha',
    label: 'Catppuccin Mocha',
    dark: true,
    theme: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      cursorAccent: '#1e1e2e',
      selectionBackground: '#585b70',
      black: '#45475a',
      red: '#f38ba8',
      green: '#a6e3a1',
      yellow: '#f9e2af',
      blue: '#89b4fa',
      magenta: '#f5c2e7',
      cyan: '#94e2d5',
      white: '#bac2de',
      brightBlack: '#585b70',
      brightRed: '#f38ba8',
      brightGreen: '#a6e3a1',
      brightYellow: '#f9e2af',
      brightBlue: '#89b4fa',
      brightMagenta: '#f5c2e7',
      brightCyan: '#94e2d5',
      brightWhite: '#a6adc8',
    },
  },
  {
    id: 'gruvbox-dark',
    label: 'Gruvbox Dark',
    dark: true,
    theme: {
      background: '#282828',
      foreground: '#ebdbb2',
      cursor: '#ebdbb2',
      cursorAccent: '#282828',
      selectionBackground: '#504945',
      black: '#282828',
      red: '#cc241d',
      green: '#98971a',
      yellow: '#d79921',
      blue: '#458588',
      magenta: '#b16286',
      cyan: '#689d6a',
      white: '#a89984',
      brightBlack: '#928374',
      brightRed: '#fb4934',
      brightGreen: '#b8bb26',
      brightYellow: '#fabd2f',
      brightBlue: '#83a598',
      brightMagenta: '#d3869b',
      brightCyan: '#8ec07c',
      brightWhite: '#ebdbb2',
    },
  },
  {
    id: 'nord',
    label: 'Nord',
    dark: true,
    theme: {
      background: '#2e3440',
      foreground: '#d8dee9',
      cursor: '#d8dee9',
      cursorAccent: '#2e3440',
      selectionBackground: '#434c5e',
      black: '#3b4252',
      red: '#bf616a',
      green: '#a3be8c',
      yellow: '#ebcb8b',
      blue: '#81a1c1',
      magenta: '#b48ead',
      cyan: '#88c0d0',
      white: '#e5e9f0',
      brightBlack: '#4c566a',
      brightRed: '#bf616a',
      brightGreen: '#a3be8c',
      brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1',
      brightMagenta: '#b48ead',
      brightCyan: '#8fbcbb',
      brightWhite: '#eceff4',
    },
  },
  {
    id: 'one-dark',
    label: 'One Dark',
    dark: true,
    theme: {
      background: '#282c34',
      foreground: '#abb2bf',
      cursor: '#528bff',
      cursorAccent: '#282c34',
      selectionBackground: '#3e4451',
      black: '#282c34',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#e5c07b',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#abb2bf',
      brightBlack: '#5c6370',
      brightRed: '#e06c75',
      brightGreen: '#98c379',
      brightYellow: '#e5c07b',
      brightBlue: '#61afef',
      brightMagenta: '#c678dd',
      brightCyan: '#56b6c2',
      brightWhite: '#ffffff',
    },
  },
  {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    dark: true,
    theme: {
      background: '#002b36',
      foreground: '#839496',
      cursor: '#93a1a1',
      cursorAccent: '#002b36',
      selectionBackground: '#073642',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#586e75',
      brightRed: '#cb4b16',
      brightGreen: '#657b83',
      brightYellow: '#839496',
      brightBlue: '#93a1a1',
      brightMagenta: '#6c71c4',
      brightCyan: '#a1a1a1',
      brightWhite: '#fdf6e3',
    },
  },
  {
    id: 'webterm-light',
    label: 'webterm Light',
    dark: false,
    theme: {
      // Pasangan `webterm-dark`: background ini ADALAH `--bg` palet app terang, jadi memilihnya —
      // yang juga membalik chrome ke terang via appTheme 'auto' — menyisakan terminal dan jendela
      // di sekelilingnya satu warna, bukan persegi pucat di atas krem. Sengaja bukan putih.
      background: '#fbf8f3',
      foreground: '#3a3028',
      cursor: '#5c4a38',
      cursorAccent: '#fbf8f3',
      selectionBackground: '#e6dcc9',
      black: '#3a3028',
      red: '#b03a2e',
      green: '#4a7c2f',
      yellow: '#9a6b00',
      blue: '#2a6099',
      magenta: '#8b4a8b',
      cyan: '#1f7a7a',
      // "white" di atas bidang pucat tidak boleh BENAR-BENAR putih atau ia hilang: ia turun ke
      // kelabu hangat, dan brightWhite lebih gelap lagi supaya teks penekanan TUI agent terbaca.
      white: '#8a7d6b',
      brightBlack: '#7a6d5c',
      brightRed: '#c9503f',
      brightGreen: '#5c9440',
      brightYellow: '#b07d00',
      brightBlue: '#3a7ab8',
      brightMagenta: '#a05ca0',
      brightCyan: '#2a9494',
      brightWhite: '#3a3028',
    },
  },
  {
    id: 'catppuccin-latte',
    label: 'Catppuccin Latte',
    dark: false,
    theme: {
      background: '#eff1f5',
      foreground: '#4c4f69',
      cursor: '#dc8a78',
      cursorAccent: '#eff1f5',
      selectionBackground: '#acb0be',
      black: '#5c5f77',
      red: '#d20f39',
      green: '#40a02b',
      yellow: '#df8e1d',
      blue: '#1e66f5',
      magenta: '#ea76cb',
      cyan: '#179299',
      white: '#acb0be',
      brightBlack: '#6c6f85',
      brightRed: '#d20f39',
      brightGreen: '#40a02b',
      brightYellow: '#df8e1d',
      brightBlue: '#1e66f5',
      brightMagenta: '#ea76cb',
      brightCyan: '#179299',
      brightWhite: '#bcc0cc',
    },
  },
  {
    id: 'solarized-light',
    label: 'Solarized Light',
    dark: false,
    theme: {
      background: '#fdf6e3',
      foreground: '#657b83',
      cursor: '#586e75',
      cursorAccent: '#fdf6e3',
      selectionBackground: '#eee8d5',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#586e75',
      brightRed: '#cb4b16',
      brightGreen: '#93a1a1',
      brightYellow: '#839496',
      brightBlue: '#268bd2',
      brightMagenta: '#6c71c4',
      brightCyan: '#2aa198',
      brightWhite: '#002b36',
    },
  },
]

const BY_ID = new Map(TERMINAL_THEMES.map((t) => [t.id, t]))

/**
 * Resolve id tema tersimpan. TOLERAN by design: nilai settings bisa diedit tangan dan melintas
 * antar versi, jadi id tak dikenal (tema yang dihapus, typo) harus turun ke default alih-alih
 * menyerahkan tema `undefined` ke xterm — yang akan menjatuhkan terminal ke latar hitam xterm
 * sendiri, alias app yang tampak rusak karena salah satu kata.
 */
export function resolveTerminalTheme(id: string | undefined): TerminalTheme {
  return (id ? BY_ID.get(id) : undefined) ?? BY_ID.get(DEFAULT_TERMINAL_THEME_ID)!
}
