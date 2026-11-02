// Tema Monaco "webterm Dark Modern" / "Light Modern": warna editor diambil dari tema bawaan
// VS Code (microsoft/vscode `extensions/theme-defaults/themes/dark_modern.json`, `light_modern.json`
// + `dark_vs`/`light_vs` untuk indent guide & seleksi). Hex di sini adalah DATA tema Monaco —
// `defineTheme` tidak menerima `var()` — jadi satu-satunya tempat warna mentah yang sah.
// Token sintaks mewarisi `vs`/`vs-dark` Monaco (itu palet Default Dark+/Light+ yang sama).
import type * as Monaco from 'monaco-editor'

export const MONACO_THEME_DARK = 'webterm-dark-modern'
export const MONACO_THEME_LIGHT = 'webterm-light-modern'

const DARK: Monaco.editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#1F1F1F',
    'editor.foreground': '#CCCCCC',
    'editor.findMatchBackground': '#9E6A03',
    'editor.inactiveSelectionBackground': '#3A3D41',
    'editor.selectionHighlightBackground': '#ADD6FF26',
    'editorLineNumber.foreground': '#6E7681',
    'editorLineNumber.activeForeground': '#CCCCCC',
    'editorIndentGuide.background1': '#404040',
    'editorIndentGuide.activeBackground1': '#707070',
    'editorOverviewRuler.border': '#010409',
    'editorWidget.background': '#202020',
    'editorSuggestWidget.background': '#202020',
    focusBorder: '#0078D4',
    'input.background': '#313131',
    'input.border': '#3C3C3C',
    'dropdown.background': '#313131',
    'dropdown.border': '#3C3C3C',
  },
}

const LIGHT: Monaco.editor.IStandaloneThemeData = {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#FFFFFF',
    'editor.foreground': '#3B3B3B',
    'editor.inactiveSelectionBackground': '#E5EBF1',
    'editor.selectionHighlightBackground': '#ADD6FF80',
    'editorLineNumber.foreground': '#6E7681',
    'editorLineNumber.activeForeground': '#171184',
    'editorIndentGuide.background1': '#D3D3D3',
    'editorIndentGuide.activeBackground1': '#939393',
    'editorOverviewRuler.border': '#E5E5E5',
    'editorWidget.background': '#F8F8F8',
    'editorSuggestWidget.background': '#F8F8F8',
    focusBorder: '#005FB8',
    'input.background': '#FFFFFF',
    'input.border': '#CECECE',
  },
}

/** Mendaftarkan kedua tema ke instance Monaco (idempoten: `defineTheme` menimpa nama yang sama). */
export function defineWebtermThemes(monaco: Pick<typeof Monaco, 'editor'>): void {
  monaco.editor.defineTheme(MONACO_THEME_DARK, DARK)
  monaco.editor.defineTheme(MONACO_THEME_LIGHT, LIGHT)
}

/** Nama tema Monaco untuk tema app saat ini (`data-theme="light"` di `<html>`, selain itu gelap). */
export function currentMonacoTheme(root: HTMLElement = document.documentElement): string {
  return root.getAttribute('data-theme') === 'light' ? MONACO_THEME_LIGHT : MONACO_THEME_DARK
}

/**
 * Opsi editor = default VS Code, kecuali dua penyimpangan sengaja karena editor hidup di node kecil:
 * minimap mati dan tidak ada ruang scroll di bawah baris terakhir. `tabSize`/`insertSpaces` TIDAK
 * diset: default VS Code (4, deteksi indentasi dari isi file) berlaku.
 */
export const EDITOR_OPTIONS: Monaco.editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
}
