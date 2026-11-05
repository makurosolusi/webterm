// Which credential-injecting wrappers are installed on the server (PATH lookup, never a shell).
// Lets the command-mode card suggest a ready command. `version` is only a version-looking token from
// `<name> --version` (2s cap); any other output is dropped.
import { defaultOnPath, spawnRun, type RunFn } from '../claudeLauncher/claudeLaunch.probe'

export const WRAPPERS = ['envman', 'direnv', 'op', 'doppler'] as const
export type WrapperName = (typeof WRAPPERS)[number]
export interface WrapperInfo { name: WrapperName; installed: boolean; version?: string }

export const VERSION_PROBE_MS = 2_000
const VERSION_RE = /v?\d+(?:\.\d+)+[\w.+-]*/

export interface DetectDeps { env: NodeJS.ProcessEnv; run?: RunFn; onPath?: (name: string) => boolean }

/** Installed state (and version, best effort) of every known wrapper. */
export function detectWrappers(d: DetectDeps): Promise<WrapperInfo[]> {
  const run = d.run ?? spawnRun
  const onPath = d.onPath ?? defaultOnPath(d.env)
  return Promise.all(WRAPPERS.map(async (name): Promise<WrapperInfo> => {
    if (!onPath(name)) return { name, installed: false }
    try {
      const r = await run(name, ['--version'], { env: d.env, timeoutMs: VERSION_PROBE_MS })
      const version = r.code === 0 ? VERSION_RE.exec(r.stdout)?.[0]?.slice(0, 40) : undefined
      return { name, installed: true, ...(version ? { version } : {}) }
    } catch {
      return { name, installed: true } // present but --version failed: still installed
    }
  }))
}
