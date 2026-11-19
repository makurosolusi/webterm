// Extra tool directories ("install paths"): one folder the user owns, every tool inside it is found in
// all webterm terminals and launches without registering each command. Stored in the sidecar
// (`extraPathDirs`), applied after the managed dir on PATH.
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { CUSTOM_COMMAND_MAX_PATH_DIRS, customCommandFail, type CustomCommandResult } from '../shared/customCommands'
import { platformDirName } from './binaryFormat'
import { loadRegistry, saveRegistry, type CustomCommandsCtx } from './customCommands.store'
import { commonToolDirs, isSafeToolDir, sessionFoundDirs } from './pathResolver'
import { createLogger } from './logs'

const log = createLogger('custom-commands')

export interface PathsView {
  managed: string
  /** Subfolder name that is searched ahead of each directory on this machine, e.g. `linux-arm64`. */
  platformDir: string
  extra: { dir: string; exists: boolean; safe: boolean }[]
  /** Usual tool dirs that exist here; scanned automatically when a command is not found. */
  common: string[]
  /** Tools found under HOME on a miss and added to PATH for this server run only; adding the dir keeps it. */
  session: { name: string; dir: string }[]
}

export function listPaths(ctx: CustomCommandsCtx): PathsView {
  return {
    managed: ctx.binDir, platformDir: platformDirName(),
    extra: loadRegistry(ctx).extraPathDirs.map((dir) => ({ dir, exists: isDir(dir), safe: isSafeToolDir(dir) })),
    common: commonToolDirs().filter(isSafeToolDir),
    session: [...sessionFoundDirs()],
  }
}
const isDir = (p: string): boolean => { try { return statSync(p).isDirectory() } catch { return false } }

/** Adds a directory: absolute, normalized, existing, not world-writable (anyone could plant a binary there); max 16. */
export function addPathDir(ctx: CustomCommandsCtx, dir: unknown): CustomCommandResult<PathsView> {
  if (typeof dir !== 'string' || dir === '' || dir.includes('\0') || !isAbsolute(dir) || dir.split('/').includes('..') || dir.includes('//')) {
    return customCommandFail('invalid_path_dir', 'Directory must be an absolute path without "..".')
  }
  const clean = dir.length > 1 ? dir.replace(/\/+$/, '') : dir
  if (!isDir(clean)) return customCommandFail('invalid_path_dir', 'Directory does not exist.')
  if (!isSafeToolDir(clean)) return customCommandFail('unsafe_path_dir', 'Directory is world-writable: any user could plant a program there. Run chmod o-w on it first.')
  if (clean === ctx.binDir) return customCommandFail('invalid_path_dir', 'That is the managed custom command directory; it is always searched.')
  try {
    const { extraPathDirs } = loadRegistry(ctx)
    if (extraPathDirs.includes(clean)) return customCommandFail('duplicate', 'Directory is already added.')
    if (extraPathDirs.length >= CUSTOM_COMMAND_MAX_PATH_DIRS) return customCommandFail('limit_reached', `At most ${CUSTOM_COMMAND_MAX_PATH_DIRS} extra directories.`)
    saveRegistry(ctx, { extraPathDirs: [...extraPathDirs, clean] })
    log.info('custom_command.path_added', 'Extra tool directory added', { count: extraPathDirs.length + 1 })
    ctx.afterPathsChange?.()
    return { ok: true, data: listPaths(ctx) }
  } catch (e) {
    return customCommandFail('write_failed', `Could not save the directory: ${(e as Error).message}`)
  }
}

export function removePathDir(ctx: CustomCommandsCtx, dir: unknown): CustomCommandResult<PathsView> {
  try {
    const { extraPathDirs } = loadRegistry(ctx)
    const clean = typeof dir === 'string' && dir.length > 1 ? dir.replace(/\/+$/, '') : dir
    if (typeof clean !== 'string' || !extraPathDirs.includes(clean)) return customCommandFail('not_found', 'That directory is not in the extra list.')
    saveRegistry(ctx, { extraPathDirs: extraPathDirs.filter((d) => d !== clean) })
    log.info('custom_command.path_removed', 'Extra tool directory removed', { count: extraPathDirs.length - 1 })
    ctx.afterPathsChange?.()
    return { ok: true, data: listPaths(ctx) }
  } catch (e) {
    return customCommandFail('write_failed', `Could not save the directory list: ${(e as Error).message}`)
  }
}
