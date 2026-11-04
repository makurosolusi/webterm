// Which language server to run for a workspace. Zero-config: the workspace's OWN binaries first
// (like problems.service.ts), then PATH; nothing found = a hint with the install command the UI shows.
//
// TypeScript 7 (native `tsgo`) ships no tsserver.js, so typescript-language-server refuses such a
// workspace ("provides no tsserver.js"); TS 7's own `tsc --lsp --stdio` is the server there.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { binaryOnPath } from '../binaryOnPath'

export const LSP_LANGUAGES = ['typescript', 'python'] as const
export type LspLanguage = (typeof LSP_LANGUAGES)[number]
export const isLspLanguage = (v: unknown): v is LspLanguage => LSP_LANGUAGES.includes(v as LspLanguage)

export interface LspCommand { cmd: string; args: string[] }
/** No server available: what the editor shows, plus the command that fixes it. */
export interface LspHint { message: string; command: string }

export const LSP_HINTS: Record<LspLanguage, LspHint> = {
  typescript: { message: 'TypeScript language server not found for this workspace.', command: 'npm install -D typescript-language-server typescript' },
  python: { message: 'Python language server (pyright) not found.', command: 'npm install -g pyright' },
}

export interface ResolveDeps {
  exists(path: string): boolean
  readFile(path: string): string
  onPath(name: string): boolean
}

const defaults: ResolveDeps = { exists: existsSync, readFile: (p) => readFileSync(p, 'utf8'), onPath: (n) => binaryOnPath(n) }

function tsMajor(root: string, d: ResolveDeps): number {
  try {
    return Number(String((JSON.parse(d.readFile(join(root, 'node_modules', 'typescript', 'package.json'))) as { version?: unknown }).version).split('.')[0]) || 0
  } catch {
    return 0 // no local typescript (or unreadable manifest): fall through to the other servers
  }
}

export function resolveLspCommand(root: string, language: LspLanguage, d: ResolveDeps = defaults): LspCommand | LspHint {
  const bin = (name: string) => join(root, 'node_modules', '.bin', name)
  if (language === 'typescript') {
    if (tsMajor(root, d) >= 7 && d.exists(bin('tsc'))) return { cmd: bin('tsc'), args: ['--lsp', '--stdio'] }
    if (d.exists(bin('typescript-language-server'))) return { cmd: bin('typescript-language-server'), args: ['--stdio'] }
    if (d.onPath('typescript-language-server')) return { cmd: 'typescript-language-server', args: ['--stdio'] }
  } else {
    if (d.exists(bin('pyright-langserver'))) return { cmd: bin('pyright-langserver'), args: ['--stdio'] }
    if (d.onPath('pyright-langserver')) return { cmd: 'pyright-langserver', args: ['--stdio'] }
  }
  return LSP_HINTS[language]
}
