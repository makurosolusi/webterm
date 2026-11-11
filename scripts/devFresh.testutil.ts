// test-only: a recording stand-in for macOS `security`, put first on PATH so no test touches the real keychain.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Write `<dir>/security` (logs its argv, answers "not found" = 44); returns a reader of the log. */
export function fakeSecurity(dir: string): () => string {
  const log = join(dir, 'security.log')
  writeFileSync(join(dir, 'security'), `#!/bin/sh\necho "$@" >> '${log}'\nexit 44\n`, { mode: 0o755 })
  return () => (existsSync(log) ? readFileSync(log, 'utf8') : '')
}
