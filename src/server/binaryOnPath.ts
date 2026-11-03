// Shared PATH probe (used by the orchestrator launcher and the claude preflight).
import { delimiter, join } from 'node:path'
import { accessSync, constants } from 'node:fs'

/** True when an executable `name` exists in a directory of `pathEnv` (default: this process's PATH). */
export function binaryOnPath(name: string, pathEnv: string = process.env['PATH'] ?? ''): boolean {
  return pathEnv.split(delimiter).some((dir) => {
    try {
      accessSync(join(dir, name), constants.X_OK)
      return true
    } catch {
      // Not in this directory (or unreadable): keep scanning; absence overall is the answer.
      return false
    }
  })
}
