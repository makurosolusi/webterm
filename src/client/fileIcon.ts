// Ikon file/folder untuk node Files dan Editor: nama codicon per ekstensi (VS Code tanpa icon theme
// ekstensi memakai codicon generik `file`/`folder`; di sini ditambah beberapa jenis yang jelas).
import { fileExt } from './editorFile'

const BY_EXT: Record<string, string> = {
  json: 'json', jsonc: 'json',
  md: 'markdown', mdx: 'markdown', markdown: 'markdown',
  png: 'file-media', jpg: 'file-media', jpeg: 'file-media', gif: 'file-media', webp: 'file-media',
  svg: 'file-media', ico: 'file-media', bmp: 'file-media', avif: 'file-media',
  pdf: 'file-pdf',
  zip: 'file-zip', tar: 'file-zip', gz: 'file-zip', tgz: 'file-zip', '7z': 'file-zip',
  sh: 'terminal', bash: 'terminal', zsh: 'terminal',
  ts: 'file-code', tsx: 'file-code', js: 'file-code', jsx: 'file-code', mjs: 'file-code',
  cjs: 'file-code', py: 'file-code', go: 'file-code', rs: 'file-code', java: 'file-code',
  c: 'file-code', cpp: 'file-code', h: 'file-code', rb: 'file-code', php: 'file-code',
  css: 'file-code', html: 'file-code', yml: 'file-code', yaml: 'file-code', toml: 'file-code',
}

/** Class codicon lengkap untuk file `name` (mis. `codicon codicon-json`). */
export function fileIconClass(name: string): string {
  return `codicon codicon-${BY_EXT[fileExt(name)] ?? 'file'}`
}

/** Class codicon folder, terbuka atau tertutup. */
export function folderIconClass(open: boolean): string {
  return `codicon codicon-${open ? 'folder-opened' : 'folder'}`
}
