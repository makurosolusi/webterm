// Shells installed on this machine, for Settings › Terminal › Default shell: the login shells listed
// in /etc/shells that really exist, plus $SHELL. Windows has no /etc/shells: the list is empty and the
// setting keeps "System default shell".
import { existsSync, readFileSync } from 'node:fs'

export const SHELLS_PATH = '/api/settings/shells'

export interface ShellsDeps {
  /** Contents of /etc/shells, or null when it cannot be read. */
  etcShells(): string | null
  exists(path: string): boolean
  envShell: string | undefined
}

const realDeps = (): ShellsDeps => ({
  etcShells: () => { try { return readFileSync('/etc/shells', 'utf8') } catch { return null } },
  exists: existsSync,
  envShell: process.env.SHELL,
})

/** Absolute paths of the installed shells, deduplicated, $SHELL first. */
export function installedShells(d: ShellsDeps = realDeps()): string[] {
  const listed = (d.etcShells() ?? '').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter((l) => l.startsWith('/'))
  const all = [...(d.envShell?.startsWith('/') ? [d.envShell] : []), ...listed]
  return [...new Set(all)].filter((p) => d.exists(p))
}
