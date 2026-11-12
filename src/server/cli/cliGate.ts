// First import of index.ts: handles CLI flags before any server module is evaluated (ES modules run
// in import order, and runCli is synchronous). No args = fall through and the server starts as before.
// A hidden entry (`__mcp-stdio`, `__eval-run`, selfLaunch.ts) is awaited here with top-level await, so
// the rest of index.ts (DB, port, tmux) never loads in that process.
import { runCli } from './cliMain'

const result = runCli(process.argv.slice(2))
if (typeof result === 'number') process.exit(result)
if (typeof result === 'object') {
  if (result.entry === 'mcp') {
    const { runMcpMain } = await import('../mcp/main')
    process.exit(await runMcpMain(result.args))
  }
  const { runEvalCli } = await import('../evalcases/evalRun.main')
  process.exit(await runEvalCli(result.args, { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) }))
}
