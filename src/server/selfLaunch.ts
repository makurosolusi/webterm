// How the server starts one of its own bundled entry points (the MCP stdio server, the eval runner) as a
// child. Three runtimes, three answers:
//   dev       `bun <file.ts>`: the source tree is on disk.
//   compiled  `webterm <hidden subcommand>`: inside `bun build --compile` the .ts files only exist in the
//             virtual `/$bunfs` filesystem and `process.execPath` is webterm itself.
//   bundled   `<runtime> <bundle entry> <hidden subcommand>`: an in-process host (the Electrobun app) runs
//             a single JS bundle with its own bun; the .ts files do not exist, and `process.execPath` is
//             a plain bun that needs the bundle path. The host DECLARES this (embedHost `selfEntry`):
//             nothing here guesses it from paths. The entry routes the subcommand through the CLI gate
//             before any window/server code loads (src/native/nativeRoute.ts).
// The hidden subcommands are handled by cli/cliArgs.ts INTERNAL_COMMANDS.
import { embedHost } from './embedHost'

/** Hidden CLI subcommands (never in --help) that run a bundled entry point in-process. */
export const MCP_STDIO_COMMAND = '__mcp-stdio'
export const EVAL_RUN_COMMAND = '__eval-run'

/** True inside a compiled binary: modules load from Bun's virtual filesystem (`/$bunfs/` on POSIX, `B:\~BUN\` on Windows). */
export const isCompiledBinary = (moduleUrl: string = import.meta.url): boolean => /\$bunfs|~BUN/.test(moduleUrl)

export type SelfLaunchMode = { kind: 'dev' } | { kind: 'compiled' } | { kind: 'bundled'; entry: string }

/** This process's mode: a registered host's bundle entry wins, then the compiled-binary check, else dev. */
export function selfLaunchMode(): SelfLaunchMode {
  const entry = embedHost()?.selfEntry
  if (entry) return { kind: 'bundled', entry }
  return isCompiledBinary() ? { kind: 'compiled' } : { kind: 'dev' }
}

/** Executable + leading args that start `script` (dev) or its hidden `subcommand` (compiled binary, bundled host). */
export function selfLaunch(subcommand: string, script: string, mode: SelfLaunchMode = selfLaunchMode()): { command: string; args: string[] } {
  if (mode.kind === 'compiled') return { command: process.execPath, args: [subcommand] }
  if (mode.kind === 'bundled') return { command: process.execPath, args: [mode.entry, subcommand] }
  return { command: process.versions.bun ? process.execPath : 'bun', args: [script] }
}
