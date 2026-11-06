// Shared PATH probe (used by the orchestrator launcher, the claude preflight and the tmux probe).
import { delimiter, join } from 'node:path'
import { accessSync, constants } from 'node:fs'

/** Absolute path of the first executable `name` in a directory of `pathEnv`, or undefined. */
export function findOnPath(name: string, pathEnv: string = process.env['PATH'] ?? ''): string | undefined {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    try {
      accessSync(join(dir, name), constants.X_OK)
      return join(dir, name)
    } catch {
      // Not in this directory (or unreadable): keep scanning; absence overall is the answer.
    }
  }
  return undefined
}

/** True when an executable `name` exists in a directory of `pathEnv` (default: this process's PATH). */
export function binaryOnPath(name: string, pathEnv: string = process.env['PATH'] ?? ''): boolean {
  return findOnPath(name, pathEnv) !== undefined
}
