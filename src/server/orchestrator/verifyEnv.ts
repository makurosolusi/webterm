// Child-process environment for verified commands (QC M4). The verifier executes scripts the
// worker just wrote, so the child must not inherit anything that grants more reach than the
// worker already had: no HOME pointing at the operator's `~/.ssh`/`~/.aws`/`~/.webterm-server`,
// no tokens, no proxy or NODE_OPTIONS injection.
import { chmodSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Only these are inherited; everything else (tokens, proxies, cloud credentials) is dropped. */
const INHERITED_ENV_KEYS = ['PATH', 'LANG', 'LC_ALL'] as const

const VERIFY_HOME_DIR = 'webterm-verify-home'

/**
 * Private scratch HOME/TMPDIR for verified commands (created 0700). It is deliberately shared per
 * host instead of created inside the worktree, so verification never dirties the repo it checks.
 */
export function verifyHomeDir(): string {
  const dir = join(tmpdir(), VERIFY_HOME_DIR)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // mkdir mode is filtered by umask; assert it explicitly.
  if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700)
  return dir
}

/**
 * Environment minimal: no inherited HOME/TMPDIR and no credential variables. `home` overrides the
 * scratch directory (tests pass a temp dir); production uses `verifyHomeDir()`.
 */
export function cleanEnv(
  source: NodeJS.ProcessEnv = process.env,
  options: { home?: string } = {}
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of INHERITED_ENV_KEYS) {
    const value = source[key]
    if (value !== undefined) env[key] = value
  }
  const home = options.home ?? verifyHomeDir()
  env.HOME = home
  env.TMPDIR = home
  env.CI = '1'
  env.NO_COLOR = '1'
  return env
}
