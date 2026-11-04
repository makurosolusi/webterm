// sh body of `webterm eval run`: hands off to the bun runner (evalcases/evalRun.main.ts) with this
// server's data dir, the same way `webterm mcp` starts mcp/main.ts with the running bun.
import { fileURLToPath } from 'node:url'
import { dataDir } from '../config'
import { shQuote } from './cli.launcher'

export const EVAL_MAIN = fileURLToPath(new URL('../evalcases/evalRun.main.ts', import.meta.url))

/** `cmd_eval`: `webterm eval run [--model fake|real] ...`; flags are parsed by the runner. */
export function buildEvalCommand(): string {
  const bun = process.versions.bun ? process.execPath : 'bun'
  return `cmd_eval() {
WEBTERM_DATA_DIR=${shQuote(dataDir())} exec ${shQuote(bun)} ${shQuote(EVAL_MAIN)} "$@"
}`
}
