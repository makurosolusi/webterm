// Auto-discovery: every executable in the managed dir and the user's extra tool dirs, plus the common
// env/secret wrappers found on PATH. Nothing is run; each file is only stat'ed and its header read.
// A tool listed here is already callable in any webterm terminal: registering is optional (shim/alias only).
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CustomCommandDetected, CustomCommandSource } from '../shared/customCommands'
import { platformDirName, inspectBinary } from './binaryFormat'
import { findOnPath } from './binaryOnPath'
import { loadRegistry, unmanaged, type CustomCommandsCtx } from './customCommands.store'
import { isExecutableFile, isSafeToolDir } from './pathResolver'

/** Common env/secret wrappers and the tools the setup terminal's recipes install, always listed (found or not). */
export const DETECT_CANDIDATES: readonly string[] = ['envman', 'op', 'doppler', 'direnv', 'dotenvx', 'infisical', 'sops', 'aws-vault', 'chamber', 'bun', 'node', 'fnm', 'uv', 'gh', 'claude']
/** Per-directory cap: a directory of thousands of files must not make the list slow. */
const DIR_SCAN_MAX = 500

function detected(name: string, path: string | null, source: CustomCommandSource): CustomCommandDetected {
  const seen = path ? inspectBinary(name, path) : null
  return { name, path, found: path !== null, source, format: seen?.format ?? 'unknown', compat: seen?.compat ?? 'unknown', compatMessage: seen?.message ?? null }
}

/** Tool directories in PATH order: for each root, its `<os>-<arch>` subfolder first, then the root. */
export function toolDirs(ctx: CustomCommandsCtx): { dir: string; source: CustomCommandSource }[] {
  const roots: { dir: string; source: CustomCommandSource }[] = [
    { dir: ctx.binDir, source: 'custom-bin' },
    ...loadRegistry(ctx).extraPathDirs.filter(isSafeToolDir).map((dir) => ({ dir, source: 'extra' as const })),
  ]
  return roots.flatMap((r) => [{ dir: join(r.dir, platformDirName()), source: r.source }, r])
}

export function detectCommands(ctx: CustomCommandsCtx): CustomCommandDetected[] {
  const out = new Map<string, CustomCommandDetected>()
  for (const { dir, source } of toolDirs(ctx)) {
    let names: string[]
    try { names = readdirSync(dir).filter((n) => !n.startsWith('.')).sort().slice(0, DIR_SCAN_MAX) } catch { continue } // absent dir: nothing to list
    for (const n of names) if (!out.has(n) && isExecutableFile(join(dir, n))) out.set(n, detected(n, join(dir, n), source))
  }
  for (const name of DETECT_CANDIDATES) {
    if (out.has(name)) continue
    const path = findOnPath(name, unmanaged(ctx)) ?? null
    out.set(name, detected(name, path, path ? 'path' : 'candidate'))
  }
  return [...out.values()]
}
