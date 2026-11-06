// test-only: fake exec seams see git argv with gitExec.ts safety flags; tests that assert the
// caller's own argv strip them first (gitExec.bun.test.ts locks the flags themselves).
const SAFETY_PAIRS = new Set(['core.fsmonitor=false', 'core.hooksPath=/dev/null'])
const SAFETY_FLAGS = new Set(['--no-ext-diff', '--no-textconv'])

/** `args` without the `-c` safety pairs and diff-driver flags gitCommand adds. */
export function withoutGitSafety(args: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c' && SAFETY_PAIRS.has(args[i + 1] ?? '')) { i++; continue }
    if (!SAFETY_FLAGS.has(args[i] as string)) out.push(args[i] as string)
  }
  return out
}
