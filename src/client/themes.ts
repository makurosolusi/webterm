import type { ITheme } from '@xterm/xterm'

/**
 * Terminal colour schemes: pure data plus one resolver, with no xterm runtime import (`ITheme` is
 * type-only) so the module loads under the node-env test runner. Turning a scheme into xterm
 * options lives in `terminalConfig.ts`.
 *
 * Every palette is an openly licensed scheme (MIT, or Apache-2.0 for Tokyo Night); sources and
 * licences are listed in `THIRD_PARTY_NOTICES.md`. Ids are stored in user settings, so they are
 * stable: `webterm-dark` / `webterm-light` are the built-in pair (labels "Dark Modern" /
 * "Light Modern", colours from the VS Code terminal defaults); the rest carry the public name of
 * their scheme.
 */

export interface TerminalTheme {
  id: string
  label: string
  /** Dark scheme or not: groups the picker and tells the surrounding node chrome which way to lean. */
  dark: boolean
  theme: ITheme
}

export const DEFAULT_TERMINAL_THEME_ID = 'webterm-dark'

/** ANSI order shared by `normal` and `bright`: black, red, green, yellow, blue, magenta, cyan, white. */
type Eight = readonly [string, string, string, string, string, string, string, string]

interface SchemeSpec {
  id: string
  label: string
  dark: boolean
  background: string
  foreground: string
  cursor?: string
  selection: string
  normal: Eight
  bright: Eight
  /** Extra xterm keys (scrollbar slider, inactive selection) for schemes that define them. */
  extra?: ITheme
}

const ANSI_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const

/** Expand a compact scheme description into the full xterm theme object. */
function scheme(spec: SchemeSpec): TerminalTheme {
  const theme: Record<string, string> = {
    background: spec.background,
    foreground: spec.foreground,
    cursor: spec.cursor ?? spec.foreground,
    cursorAccent: spec.background,
    selectionBackground: spec.selection,
  }
  ANSI_NAMES.forEach((name, i) => {
    theme[name] = spec.normal[i]
    theme[`bright${name[0].toUpperCase()}${name.slice(1)}`] = spec.bright[i]
  })
  return { id: spec.id, label: spec.label, dark: spec.dark, theme: { ...theme, ...spec.extra } }
}

// VS Code terminal defaults and Dark/Light Modern editor colours (MIT, Microsoft).
const VSCODE_DARK = scheme({
  id: 'webterm-dark',
  label: 'Dark Modern',
  dark: true,
  background: '#1f1f1f',
  foreground: '#cccccc',
  selection: '#264f78',
  normal: ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5'],
  bright: ['#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#e5e5e5'],
  extra: {
    selectionInactiveBackground: '#264f7880',
    scrollbarSliderBackground: '#79797966',
    scrollbarSliderHoverBackground: '#646464b3',
    scrollbarSliderActiveBackground: '#bfbfbf66',
  },
})

const VSCODE_LIGHT = scheme({
  id: 'webterm-light',
  label: 'Light Modern',
  dark: false,
  background: '#ffffff',
  foreground: '#3b3b3b',
  cursor: '#005fb8',
  selection: '#add6ff',
  normal: ['#000000', '#cd3131', '#107c10', '#949800', '#0451a5', '#bc05bc', '#0598bc', '#555555'],
  bright: ['#666666', '#f14c4c', '#14ce14', '#b5ba00', '#3b8eea', '#d670d6', '#29b8db', '#a5a5a5'],
  extra: {
    selectionInactiveBackground: '#add6ff80',
    scrollbarSliderBackground: '#64646466',
    scrollbarSliderHoverBackground: '#646464b3',
    scrollbarSliderActiveBackground: '#00000099',
  },
})

// Solarized (MIT, Ethan Schoonover): the published 16-colour terminal mapping. Bright black and
// bright green use base01 instead of base03 so "dim" text stays readable on the dark background.
const SOLARIZED_NORMAL: Eight = ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5']
const SOLARIZED_BRIGHT: Eight = ['#586e75', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3']

export const TERMINAL_THEMES: readonly TerminalTheme[] = [
  VSCODE_DARK,
  // Dracula (MIT, Dracula Theme)
  scheme({
    id: 'dracula', label: 'Dracula', dark: true,
    background: '#282a36', foreground: '#f8f8f2', selection: '#44475a',
    normal: ['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2'],
    bright: ['#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff'],
  }),
  // Tokyo Night (Apache-2.0, folke/tokyonight.nvim)
  scheme({
    id: 'tokyo-night', label: 'Tokyo Night', dark: true,
    background: '#1a1b26', foreground: '#c0caf5', selection: '#33467c',
    normal: ['#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6'],
    bright: ['#414868', '#ff899d', '#9fe044', '#faba4a', '#8db0ff', '#c7a9ff', '#a4daff', '#c0caf5'],
  }),
  // Catppuccin Mocha (MIT, Catppuccin)
  scheme({
    id: 'catppuccin-mocha', label: 'Catppuccin Mocha', dark: true,
    background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', selection: '#585b70',
    normal: ['#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de'],
    bright: ['#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8'],
  }),
  // Gruvbox dark (MIT/X11, Pavel Pertsev)
  scheme({
    id: 'gruvbox-dark', label: 'Gruvbox Dark', dark: true,
    background: '#282828', foreground: '#ebdbb2', selection: '#504945',
    normal: ['#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984'],
    bright: ['#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2'],
  }),
  // Nord (MIT, Sven Greb)
  scheme({
    id: 'nord', label: 'Nord', dark: true,
    background: '#2e3440', foreground: '#d8dee9', selection: '#434c5e',
    normal: ['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0'],
    bright: ['#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4'],
  }),
  // One Dark (MIT, GitHub Inc., Atom one-dark-syntax)
  scheme({
    id: 'one-dark', label: 'One Dark', dark: true,
    background: '#282c34', foreground: '#abb2bf', cursor: '#528bff', selection: '#3e4451',
    normal: ['#282c34', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf'],
    bright: ['#5c6370', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff'],
  }),
  scheme({
    id: 'solarized-dark', label: 'Solarized Dark', dark: true,
    background: '#002b36', foreground: '#839496', cursor: '#93a1a1', selection: '#073642',
    normal: SOLARIZED_NORMAL, bright: SOLARIZED_BRIGHT,
  }),
  VSCODE_LIGHT,
  // Catppuccin Latte (MIT, Catppuccin)
  scheme({
    id: 'catppuccin-latte', label: 'Catppuccin Latte', dark: false,
    background: '#eff1f5', foreground: '#4c4f69', cursor: '#dc8a78', selection: '#acb0be',
    normal: ['#5c5f77', '#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#ea76cb', '#179299', '#acb0be'],
    bright: ['#6c6f85', '#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#ea76cb', '#179299', '#bcc0cc'],
  }),
  scheme({
    id: 'solarized-light', label: 'Solarized Light', dark: false,
    background: '#fdf6e3', foreground: '#657b83', cursor: '#586e75', selection: '#eee8d5',
    normal: SOLARIZED_NORMAL, bright: SOLARIZED_BRIGHT,
  }),
]

const BY_ID = new Map(TERMINAL_THEMES.map((t) => [t.id, t]))

/**
 * Resolve a stored theme id. Tolerant on purpose: settings can be hand-edited or cross versions, and
 * an unknown id must fall back to the default rather than hand xterm an undefined theme (which
 * paints xterm's own black background).
 */
export function resolveTerminalTheme(id: string | undefined): TerminalTheme {
  return (id ? BY_ID.get(id) : undefined) ?? BY_ID.get(DEFAULT_TERMINAL_THEME_ID)!
}
