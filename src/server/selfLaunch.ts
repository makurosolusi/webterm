// How the server starts one of its own bundled entry points (the MCP stdio server, the eval runner) as a
// child. Under `bun run dev` that is `bun <file.ts>`. Inside a `bun build --compile` binary the .ts files
// only exist in the virtual `/$bunfs` filesystem and `process.execPath` is webterm itself, so the child is
// `webterm <hidden subcommand>` instead (cli/cliArgs.ts INTERNAL_COMMANDS routes it in-process).

/** Hidden CLI subcommands (never in --help) that run a bundled entry point in-process. */
export const MCP_STDIO_COMMAND = '__mcp-stdio'
export const EVAL_RUN_COMMAND = '__eval-run'

/** True inside a compiled binary: modules load from Bun's virtual filesystem (`/$bunfs/` on POSIX, `B:\~BUN\` on Windows). */
export const isCompiledBinary = (moduleUrl: string = import.meta.url): boolean => /\$bunfs|~BUN/.test(moduleUrl)

/** Executable + leading args that start `script` (dev) or its hidden `subcommand` (compiled binary). */
export function selfLaunch(subcommand: string, script: string, compiled: boolean = isCompiledBinary()): { command: string; args: string[] } {
  if (compiled) return { command: process.execPath, args: [subcommand] }
  return { command: process.versions.bun ? process.execPath : 'bun', args: [script] }
}
