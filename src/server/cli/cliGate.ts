// First import of index.ts: handles CLI flags before any server module is evaluated (ES modules run
// in import order, and runCli is synchronous). No args = fall through and the server starts as before.
import { runCli } from './cliMain'

const result = runCli(process.argv.slice(2))
if (result !== 'serve') process.exit(result)
