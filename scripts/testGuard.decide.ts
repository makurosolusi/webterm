// Pure allow/deny decisions for "is this run a full suite in disguise?". Used by the vitest
// globalSetup (scripts/vitestGuard.ts), the bun test preload (scripts/bunTestGuard.ts) and the
// npm `test` / `test:bun` gate (scripts/test.fullGate.ts). Kept free of I/O so it is unit-testable.

/** Set to `1` only by the owner or CI to run a whole suite. Agents must never set it. */
export const FULL_TESTS_ENV = 'WEBTERM_FULL_TESTS'
/** More positional filters than this is a full suite spelled out as a list. */
export const MAX_FILTERS = 60

export const FULL_SUITE_MESSAGE =
  'Full test suite needs an explicit command from the owner. Use `npm run test:impacted`. Owner: `npm run test:all` / `npm run test:bun:all`.'

export type Decision = { allow: true } | { allow: false; reason: string }

const ALLOW: Decision = { allow: true }
const deny = (reason: string): Decision => ({ allow: false, reason })

/** True when the environment explicitly opens the full suite (owner / CI). */
export const fullTestsOpen = (env: Record<string, string | undefined>): boolean => env[FULL_TESTS_ENV] === '1'

/** Flags that take a separate value argument, so the value is not mistaken for a file filter. */
const VITEST_VALUE_FLAGS = new Set([
  'c', 'config', 'r', 'root', 'dir', 'project', 'reporter', 'outputFile', 'maxWorkers', 'minWorkers', 'pool', 'environment',
  'testTimeout', 'hookTimeout', 'shard', 'exclude', 'mode', 'sequence', 'retry', 't', 'testNamePattern',
])
const BUN_VALUE_FLAGS = new Set([
  'timeout', 'rerun-each', 'preload', 'r', 'config', 'c', 'cwd', 'reporter', 'reporter-outfile', 'coverage-reporter',
  'coverage-dir', 'max-concurrency', 'seed', 'path-ignore-patterns', 't', 'test-name-pattern',
])
const VITEST_SUBCOMMANDS = new Set(['run', 'watch', 'dev', 'related', 'bench', 'list', 'typecheck'])

type Parsed = { positional: string[]; flags: Set<string> }

/** Splits args into positional words and flag names; `--flag=value` and known value flags are handled. */
function parseArgs(args: string[], valueFlags: Set<string>): Parsed {
  const positional: string[] = []
  const flags = new Set<string>()
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (!a.startsWith('-')) { positional.push(a); continue }
    const eq = a.indexOf('=')
    const name = a.slice(0, eq < 0 ? undefined : eq).replace(/^-+/, '')
    flags.add(name)
    if (eq < 0 && valueFlags.has(name)) i++
  }
  return { positional, flags }
}

/** `argv` is the CLI argument list after the vitest binary (e.g. `process.argv.slice(2)`). */
export function decideVitest(argv: string[], env: Record<string, string | undefined>): Decision {
  if (fullTestsOpen(env)) return ALLOW
  const { positional, flags } = parseArgs(argv, VITEST_VALUE_FLAGS)
  const filters = VITEST_SUBCOMMANDS.has(positional[0] ?? '') ? positional.slice(1) : positional
  if (filters.length > MAX_FILTERS) return deny(`${FULL_SUITE_MESSAGE} (${filters.length} file filters; the limit is ${MAX_FILTERS}.)`)
  const narrowed = filters.length > 0 || flags.has('changed') || flags.has('t') || flags.has('testNamePattern')
  return narrowed ? ALLOW : deny(FULL_SUITE_MESSAGE)
}

/** `argv` is the CLI argument list after `bun test`. */
export function decideBun(argv: string[], env: Record<string, string | undefined>): Decision {
  if (fullTestsOpen(env)) return ALLOW
  const { positional } = parseArgs(argv, BUN_VALUE_FLAGS)
  if (positional.length > MAX_FILTERS) return deny(`${FULL_SUITE_MESSAGE} (${positional.length} paths; the limit is ${MAX_FILTERS}.)`)
  // `-t <pattern>` alone still scans every file, so only a path counts as narrowing.
  return positional.length > 0 ? ALLOW : deny(FULL_SUITE_MESSAGE)
}

/** Arguments after the `test` word of a `bun test ...` command line; null when it is not one. */
export function bunTestArgs(cmdline: string[]): string[] | null {
  const i = cmdline.indexOf('test')
  return i >= 0 && i <= 2 ? cmdline.slice(i + 1) : null
}
