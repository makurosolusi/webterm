// sh body of `webterm eval run`: hands off to the bun runner (evalcases/evalRun.main.ts) with this
// server's data dir, started like `webterm mcp` (selfLaunch.ts: bun + the file in dev, `__eval-run` in the binary or the native app's bundle).
import { fileURLToPath } from 'node:url'
import { dataDir } from '../config'
import { EVAL_RUN_COMMAND, selfLaunch } from '../selfLaunch'
import { shQuote } from './cli.launcher'

export const EVAL_MAIN = fileURLToPath(new URL('../evalcases/evalRun.main.ts', import.meta.url))

/** `cmd_eval`: `webterm eval run [--model fake|real] ...`; flags are parsed by the runner. */
export function buildEvalCommand(): string {
  const { command, args } = selfLaunch(EVAL_RUN_COMMAND, EVAL_MAIN)
  return `cmd_eval() {
WEBTERM_DATA_DIR=${shQuote(dataDir())} exec ${[command, ...args].map(shQuote).join(' ')} "$@"
}`
}
