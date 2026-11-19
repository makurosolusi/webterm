// The managed custom-bin directory and the one PATH rule that puts it first. Pure (no mkdir): ptyEnv
// runs in hot paths and tests, so creating the directory is the store's job (customCommands.store.ts).
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { platformDirName } from './binaryFormat'

const isDir = (p: string): boolean => { try { return statSync(p).isDirectory() } catch { return false } }

export const CUSTOM_BIN_ENV = 'WEBTERM_CUSTOM_BIN'

/** `WEBTERM_CUSTOM_BIN`, else `<WEBTERM_DATA_DIR or ~/.webterm-server>/custom-bin`. */
export function customBinPath(env: NodeJS.ProcessEnv = process.env): string {
  return env[CUSTOM_BIN_ENV] || join(env.WEBTERM_DATA_DIR || join(env.HOME || homedir(), '.webterm-server'), 'custom-bin')
}

// User-chosen extra tool dirs (sidecar `extraPathDirs`), mirrored here so ptyEnv stays synchronous and
// free of file reads. Refreshed by pathResolver (boot, API mutation, every miss/rescan).
let extraDirs: readonly string[] = []
export const getExtraPathDirs = (): readonly string[] => extraDirs
export const setExtraPathDirs = (dirs: readonly string[]): void => { extraDirs = [...dirs] }

/** `pathEnv` with `dir` first, then the extra dirs, then the rest (no duplicates). */
export function withCustomBin(pathEnv: string | undefined, dir: string, extra: readonly string[] = extraDirs): string {
  // `<dir>/<os>-<arch>` (e.g. linux-arm64) goes right before its parent: one folder can hold builds for every platform.
  const head = [dir, ...extra].flatMap((d) => { const sub = join(d, platformDirName()); return isDir(sub) ? [sub, d] : [d] })
  return [...head, ...(pathEnv ?? '').split(delimiter).filter((e) => e && !head.includes(e))].join(delimiter)
}

/** Boot step: put the custom-bin dir first in this process's PATH so binaryExists/doctor/launchers find it. */
export function putCustomBinOnProcessPath(env: NodeJS.ProcessEnv = process.env): void {
  env.PATH = withCustomBin(env.PATH, customBinPath(env))
}
