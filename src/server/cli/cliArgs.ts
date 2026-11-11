// Pure argv parser for the server entry: argv -> one action. No I/O; cliMain.ts runs the action.
// Conventions follow git/gh: unknown input is an error (exit 2) with a "did you mean" hint, never a
// silent server start.

export type CliAction =
  | { kind: 'serve' }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'readme' }
  | { kind: 'docs'; topic?: string }
  | { kind: 'reset-password'; username: string }
  | { kind: 'error'; message: string }

export interface CliOption {
  /** Omitted for rare, destructive flags that should be typed out in full. */
  short?: string
  long: string
  arg?: string
  description: string
}

/** Every flag the entry accepts, in help order. */
export const CLI_OPTIONS: readonly CliOption[] = [
  { short: '-h', long: '--help', description: 'Show this help and exit.' },
  { short: '-v', long: '--version', description: 'Print the version and build id and exit.' },
  { short: '-r', long: '--readme', description: 'Print the README (paged through less on a terminal).' },
  { short: '-d', long: '--docs', arg: '[topic]', description: 'List documentation topics, or print one topic.' },
  { long: '--reset-password', arg: '<username>', description: 'Set a new password for an account (read from the terminal or stdin) and sign it out everywhere. The server need not run.' },
]

type FlagKind = 'help' | 'version' | 'readme' | 'docs' | 'reset-password'
const FLAG_KIND = new Map<string, FlagKind>(
  CLI_OPTIONS.flatMap((o) => {
    const kind = o.long.slice(2) as FlagKind
    return o.short ? [[o.short, kind], [o.long, kind]] as const : [[o.long, kind]] as const
  }),
)
/** Flags whose value is required (`--flag value` or `--flag=value`). */
const NEEDS_VALUE: ReadonlySet<FlagKind> = new Set(['reset-password'])
/** When several flags are given, the first in this list wins (`-h -v` prints help). */
const PRIORITY: readonly FlagKind[] = ['help', 'version', 'readme', 'docs', 'reset-password']
const MAX_SUGGEST_DISTANCE = 2

/** Edit distance (insert/delete/substitute), two-row DP. */
export function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]
}

/** Closest known long flag for a mistyped argument, or undefined when nothing is close. */
export function suggestOption(input: string): string | undefined {
  const bare = input.replace(/^-+/, '').split('=')[0].toLowerCase()
  let best: { long: string; d: number } | undefined
  for (const o of CLI_OPTIONS) {
    const d = levenshtein(bare, o.long.slice(2))
    if (d <= MAX_SUGGEST_DISTANCE && (!best || d < best.d)) best = { long: o.long, d }
  }
  return best?.long
}

function unknown(arg: string): CliAction {
  const hint = suggestOption(arg)
  const what = arg.startsWith('-') ? 'option' : 'argument'
  return { kind: 'error', message: `unknown ${what} '${arg}'${hint ? `\ndid you mean '${hint}'?` : ''}` }
}

/** Parse argv (without the runtime and script path). Empty argv = start the server. */
export function parseArgs(argv: readonly string[]): CliAction {
  const seen = new Set<FlagKind>()
  const values = new Map<FlagKind, string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1
    const name = eq > 0 ? arg.slice(0, eq) : arg
    const kind = FLAG_KIND.get(name)
    if (!kind) return unknown(arg)
    const takesValue = kind === 'docs' || NEEDS_VALUE.has(kind)
    if (eq > 0 && !takesValue) return { kind: 'error', message: `option '${name}' takes no value` }
    seen.add(kind)
    if (!takesValue) continue
    if (eq > 0) values.set(kind, arg.slice(eq + 1))
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) values.set(kind, argv[++i])
    if (NEEDS_VALUE.has(kind) && !values.get(kind)) return { kind: 'error', message: `option '${name}' needs a value` }
  }
  const winner = PRIORITY.find((k) => seen.has(k))
  if (!winner) return { kind: 'serve' }
  if (winner === 'docs') return { kind: 'docs', topic: values.get('docs') }
  if (winner === 'reset-password') return { kind: 'reset-password', username: values.get('reset-password') as string }
  return { kind: winner }
}
