// Argv router of the native app's bundle entry (main.ts). The app re-enters its own bundle for hidden
// subcommands (`<bun> index.js __mcp-stdio ...`, selfLaunch.ts), so a child must reach the CLI gate WITHOUT
// evaluating the window code: `electrobun/main` loads native libraries, overrides process.exit and installs
// a crash handler at import time, and the window code opens a window and starts the server. Plain module,
// no Electrobun import: testable headless with injected importers.
import { EVAL_RUN_COMMAND, MCP_STDIO_COMMAND } from '../server/selfLaunch'

const INTERNAL = new Set([MCP_STDIO_COMMAND, EVAL_RUN_COMMAND])

export interface NativeImporters {
  /** The CLI gate (server/cli/cliGate.ts): runs the hidden entry and exits. */
  cli(): Promise<unknown>
  /** The window + in-process server (nativeApp.ts). */
  app(): Promise<unknown>
}

/** Load the CLI gate for a hidden subcommand, else the app. `argv` excludes runtime and script. */
export async function routeNative(argv: readonly string[], load: NativeImporters): Promise<'cli' | 'app'> {
  if (INTERNAL.has(argv[0] ?? '')) {
    await load.cli()
    return 'cli'
  }
  await load.app()
  return 'app'
}
