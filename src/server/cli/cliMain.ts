// Runs a parsed CLI action. Fully synchronous (writeSync, spawnSync for the pager, sync hashing for
// --reset-password) so cliGate.ts can
// exit before index.ts evaluates its next import: no DB, port, tmux or ledger is touched for a flag.
import { spawnSync } from 'node:child_process'
import { writeSync } from 'node:fs'
import { join } from 'node:path'
import pkg from '../../../package.json'
import readme from '../../../README.md' with { type: 'text' }
import { findOnPath } from '../binaryOnPath'
import { childEnv } from '../childEnv'
import { createServerIdentity } from '../health.api'
import { type InternalEntry, parseArgs } from './cliArgs'
import { buildHelp, buildTopicList, buildVersion, docsTopic, topicSlugs } from './cliHelp'
import type * as ResetPassword from './cliResetPassword'
import type * as CommandCli from '../customCommands.cli'
import type * as CommandStore from '../customCommands.store'

export const EXIT_OK = 0
export const EXIT_USAGE = 2
const STDOUT = 1
const STDERR = 2

/** Write all of `text` to a file descriptor (writeSync can write fewer bytes than asked). */
function writeAll(fd: number, text: string): void {
  const buf = Buffer.from(text)
  for (let off = 0; off < buf.length;) off += writeSync(fd, buf, off)
}

/** Page through `less -R` on a terminal when available; otherwise (or if less fails) print raw. */
function page(text: string): void {
  const less = process.stdout.isTTY ? findOnPath('less') : undefined
  if (less) {
    const r = spawnSync(less, ['-R'], { input: text, stdio: ['pipe', 'inherit', 'inherit'], env: childEnv() })
    if (!r.error && (r.status === 0 || r.signal !== null)) return
  }
  writeAll(STDOUT, text)
}

function usageError(message: string): number {
  writeAll(STDERR, `webterm: ${message}\nRun 'webterm --help' for usage.\n`)
  return EXIT_USAGE
}

/** Run the CLI for `argv` (without runtime/script). Returns an exit code, 'serve' to start the server, or a hidden entry for cliGate to await. */
export function runCli(argv: readonly string[]): number | 'serve' | { entry: InternalEntry; args: string[] } {
  const action = parseArgs(argv)
  switch (action.kind) {
    case 'serve':
      return 'serve'
    case 'internal':
      return { entry: action.entry, args: action.args }
    case 'error':
      return usageError(action.message)
    case 'help':
      writeAll(STDOUT, buildHelp())
      return EXIT_OK
    case 'version': {
      // Same build id as GET /api/health; the dist path mirrors index.ts DIST_DIR.
      const { build } = createServerIdentity({ distDir: join(import.meta.dirname, '../../../dist'), dev: process.env.NODE_ENV !== 'production' })
      writeAll(STDOUT, buildVersion(pkg.version, build))
      return EXIT_OK
    }
    case 'reset-password': {
      // Loaded only for this flag: its import chain (db.ts and friends) creates the data dir, and the
      // other flags must leave no trace. require() stays synchronous and is bundled by `--compile`.
      const { runResetPassword } = require('./cliResetPassword') as typeof ResetPassword
      return runResetPassword(action.username, { writeErr: (t) => writeAll(STDERR, t), writeOut: (t) => writeAll(STDOUT, t) })
    }
    case 'command': {
      // Loaded only for this verb (its imports create the data dir); require() stays synchronous.
      const { runCommandCli } = require('../customCommands.cli') as typeof CommandCli
      const { defaultCtx } = require('../customCommands.store') as typeof CommandStore
      return runCommandCli(action.args, defaultCtx(), { out: (t) => writeAll(STDOUT, t), err: (t) => writeAll(STDERR, t) })
    }
    case 'readme':
      page(readme)
      return EXIT_OK
    case 'docs': {
      if (action.topic === undefined) {
        writeAll(STDOUT, buildTopicList(readme))
        return EXIT_OK
      }
      const text = docsTopic(readme, action.topic)
      if (text === undefined) return usageError(`unknown docs topic '${action.topic}'\ntopics: ${topicSlugs(readme).join(', ')}`)
      page(text)
      return EXIT_OK
    }
  }
}
