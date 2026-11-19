// Custom command registry: sidecar `<dataDir>/custom-commands.json` plus one file per command in the
// managed bin dir (customBinPath). Existence checks only: nothing registered here is ever executed.
import { accessSync, chmodSync, constants, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, normalize, sep } from 'node:path'
import {
  CUSTOM_COMMAND_MAX_ENTRIES, CUSTOM_COMMAND_NOTE_MAX_CHARS, customCommandFail, renderShim, validateCustomCommandArgv, validateCustomCommandName,
  type CustomCommandAddRequest, type CustomCommandDetected, type CustomCommandEntry, type CustomCommandResult, type CustomCommandStatus,
} from '../shared/customCommands'
import { findOnPath } from './binaryOnPath'
import { platformDirName, inspectBinary } from './binaryFormat'
import { customBinPath, withCustomBin } from './customBinPath'
import { loginShellPathAsync } from './loginShellPath'
import { configurePathResolver, isExecutableFile as isExecutable, scanToolDirs } from './pathResolver'
import { dataDir } from './config'
import { createLogger } from './logs'

const log = createLogger('custom-commands')
const REGISTRY_FILE = 'custom-commands.json'
const REGISTRY_VERSION = 1

export interface CustomCommandsCtx {
  binDir: string
  registryFile: string
  /** The PATH to resolve against (the managed dir is removed from it before lookups). */
  pathEnv: () => string
  now: () => number
  /** Called after the extra tool dirs changed (the server re-applies PATH); tests omit it. */
  afterPathsChange?: () => void
}

export const defaultCtx = (): CustomCommandsCtx => ({
  binDir: customBinPath(), registryFile: join(dataDir(), REGISTRY_FILE), pathEnv: () => process.env.PATH ?? '', now: Date.now, afterPathsChange: () => { scanToolDirs() },
})

export const unmanaged = (ctx: CustomCommandsCtx): string => ctx.pathEnv().split(delimiter).filter((e) => e && e !== ctx.binDir && e !== join(ctx.binDir, platformDirName())).join(delimiter)
const isLink = (p: string): boolean => { try { return lstatSync(p).isSymbolicLink() } catch { return false } }
const exists = (p: string): boolean => { try { lstatSync(p); return true } catch { return false } }
const realOrNull = (p: string): string | null => { try { return realpathSync(p) } catch { return null } }

interface Registry { entries: CustomCommandEntry[]; extraPathDirs: string[] }

/** The sidecar. A missing file is empty; an unreadable or malformed one throws with the path named. */
export function loadRegistry(ctx: CustomCommandsCtx): Registry {
  let raw: string
  try {
    raw = readFileSync(ctx.registryFile, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], extraPathDirs: [] }
    throw new Error(`custom commands: cannot read ${ctx.registryFile}: ${(e as Error).message}`)
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Registry>
    if (!Array.isArray(parsed.entries)) throw new Error('entries is not an array')
    return { entries: parsed.entries, extraPathDirs: Array.isArray(parsed.extraPathDirs) ? parsed.extraPathDirs : [] }
  } catch (e) {
    throw new Error(`custom commands: ${ctx.registryFile} is malformed: ${(e as Error).message}`)
  }
}
export const loadEntries = (ctx: CustomCommandsCtx): CustomCommandEntry[] => loadRegistry(ctx).entries

/** Atomic write of `patch` over the current registry: temp file in the same directory, then rename. */
export function saveRegistry(ctx: CustomCommandsCtx, patch: Partial<Registry>): void {
  const tmp = `${ctx.registryFile}.tmp-${process.pid}`
  mkdirSync(dirname(ctx.registryFile), { recursive: true })
  writeFileSync(tmp, `${JSON.stringify({ version: REGISTRY_VERSION, ...loadRegistry(ctx), ...patch }, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, ctx.registryFile)
}
const saveEntries = (ctx: CustomCommandsCtx, entries: CustomCommandEntry[]): void => saveRegistry(ctx, { entries })

/** Creates the managed dir (0700) and checks it is writable; false when it is read-only (Docker mount). */
export function ensureBinDir(ctx: CustomCommandsCtx): boolean {
  try {
    mkdirSync(ctx.binDir, { recursive: true, mode: 0o700 })
    accessSync(ctx.binDir, constants.W_OK)
    return true
  } catch (e) {
    log.warn('custom_command.bin_dir_unavailable', 'Custom command directory is not writable', { code: (e as NodeJS.ErrnoException).code })
    return false
  }
}

/** Boot: create the dir, wire the PATH resolver, and put the managed + extra dirs first on this process's PATH
 *  (a read-only dir is fine, it is still searched). */
export function bootCustomBin(env: NodeJS.ProcessEnv = process.env): void {
  const ctx = { ...defaultCtx(), binDir: customBinPath(env) }
  ensureBinDir(ctx)
  configurePathResolver({
    loginPath: loginShellPathAsync,
    loadExtras: () => { try { return loadRegistry(ctx).extraPathDirs } catch (e) { log.warn('custom_command.registry_unreadable', 'Extra tool dirs not loaded', { cause: (e as Error).message.slice(0, 120) }); return [] } },
  })
  scanToolDirs(env)
}

/** Status of one stored entry; existence checks only. */
export function statusOf(ctx: CustomCommandsCtx, e: CustomCommandEntry): CustomCommandStatus {
  const installed = exists(join(ctx.binDir, e.name))
  const resolved = e.kind === 'link'
    ? (e.target && isExecutable(e.target) ? realOrNull(e.target) : null)
    : programPath(ctx, e.argv?.[0] ?? '')
  const other = findOnPath(e.name, unmanaged(ctx)) ?? null
  const shadows = other !== null && realOrNull(other) !== resolved ? other : null
  const seen = resolved ? inspectBinary(e.kind === 'link' ? e.name : (e.argv?.[0] ?? e.name), resolved) : null
  return {
    ...e, found: installed && resolved !== null, resolved, shadows,
    format: seen?.format ?? 'unknown', compat: seen?.compat ?? 'unknown', compatMessage: seen?.message ?? null,
  }
}

function programPath(ctx: CustomCommandsCtx, program: string): string | null {
  if (program === '') return null
  if (program.includes('/')) return isAbsolute(program) && isExecutable(program) ? program : null
  return findOnPath(program, unmanaged(ctx)) ?? null
}

export const listCommands = (ctx: CustomCommandsCtx): CustomCommandStatus[] => loadEntries(ctx).map((e) => statusOf(ctx, e))

/** Where `name` resolves with the managed PATH; `custom` is true when a registered command answers. */
export function whichCommand(ctx: CustomCommandsCtx, name: string): { name: string; path: string | null; custom: boolean } {
  const entry = loadEntries(ctx).find((e) => e.name === name)
  if (entry) return { name, path: statusOf(ctx, entry).resolved, custom: true }
  return { name, path: findOnPath(name, withCustomBin(ctx.pathEnv(), ctx.binDir)) ?? null, custom: false }
}

/** Absolute, normalized, existing, executable regular file, outside the managed dir. */
function checkTarget(ctx: CustomCommandsCtx, target: unknown): CustomCommandResult<string> {
  if (typeof target !== 'string' || target === '' || target.includes('\0') || !isAbsolute(target) || normalize(target) !== target) {
    return customCommandFail('invalid_target', 'Target must be an absolute, normalized path (no "..", no repeated slashes).')
  }
  const real = realOrNull(target)
  if (real === null || !isExecutable(real)) return customCommandFail('invalid_target', 'Target does not exist or is not an executable file.')
  const bin = realOrNull(ctx.binDir) ?? ctx.binDir
  // Both spellings: a symlink INSIDE the dir resolves to a tool outside it, but would still chain through the dir.
  const inBin = (p: string): boolean => [bin, ctx.binDir].some((b) => p === b || p.startsWith(b + sep))
  if (inBin(real) || inBin(target as string)) return customCommandFail('invalid_target', 'Target must not live inside the managed custom command directory.')
  return { ok: true, data: target }
}

/** Writes the command file atomically (temp name + rename over any previous one). */
function install(ctx: CustomCommandsCtx, e: CustomCommandEntry): void {
  const dest = join(ctx.binDir, e.name)
  const tmp = join(ctx.binDir, `.tmp-${process.pid}-${e.name}`)
  if (exists(tmp)) unlinkSync(tmp)
  if (e.kind === 'link') symlinkSync(e.target as string, tmp)
  else { writeFileSync(tmp, renderShim(e.name, e.argv as string[], ctx.binDir), { mode: 0o755 }); chmodSync(tmp, 0o755) }
  renameSync(tmp, dest)
}

/** Registers a command. Validation errors are results; filesystem failures become write_failed. */
export function addCommand(ctx: CustomCommandsCtx, req: CustomCommandAddRequest): CustomCommandResult<CustomCommandStatus> {
  const force = req.force === true
  const name = validateCustomCommandName(req.name, force)
  if (!name.ok) return name
  if (req.note !== undefined && (typeof req.note !== 'string' || req.note.length > CUSTOM_COMMAND_NOTE_MAX_CHARS)) {
    return customCommandFail('invalid_note', `Note must be a string of at most ${CUSTOM_COMMAND_NOTE_MAX_CHARS} chars.`)
  }
  const entry: CustomCommandEntry = { name: name.data, kind: req.kind, addedAt: ctx.now(), ...(req.note ? { note: req.note } : {}) }
  if (req.kind === 'link') {
    const t = checkTarget(ctx, req.target)
    if (!t.ok) return t
    entry.target = t.data
  } else if (req.kind === 'shim') {
    const a = validateCustomCommandArgv(req.argv)
    if (!a.ok) return a
    entry.argv = a.data
  } else return customCommandFail('invalid_kind', 'kind must be "link" or "shim".')
  try {
    const entries = loadEntries(ctx)
    const prior = entries.find((e) => e.name === entry.name)
    if (prior && !force) return customCommandFail('duplicate', `"${entry.name}" is already registered; remove it first or pass force.`)
    if (!prior && entries.length >= CUSTOM_COMMAND_MAX_ENTRIES) return customCommandFail('limit_reached', `At most ${CUSTOM_COMMAND_MAX_ENTRIES} custom commands.`)
    if (!ensureBinDir(ctx)) return customCommandFail('bin_dir_readonly', 'The custom command directory is read-only; set WEBTERM_CUSTOM_BIN to a writable directory.')
    install(ctx, entry)
    saveEntries(ctx, [...entries.filter((e) => e.name !== entry.name), entry].sort((a, b) => a.name.localeCompare(b.name)))
    log.info('custom_command.added', 'Custom command registered', { name: entry.name, kind: entry.kind, forced: force })
    return { ok: true, data: statusOf(ctx, entry) }
  } catch (e) {
    log.error('custom_command.add_failed', 'Could not register custom command', { name: entry.name, code: (e as NodeJS.ErrnoException).code })
    return customCommandFail('write_failed', `Could not write the command: ${(e as Error).message}`)
  }
}

export function removeCommand(ctx: CustomCommandsCtx, name: string): CustomCommandResult<{ name: string }> {
  try {
    const entries = loadEntries(ctx)
    if (!entries.some((e) => e.name === name)) return customCommandFail('not_found', `"${name}" is not a registered custom command.`)
    if (!ensureBinDir(ctx)) return customCommandFail('bin_dir_readonly', 'The custom command directory is read-only; nothing was removed.')
    const file = join(ctx.binDir, name)
    if (exists(file) || isLink(file)) unlinkSync(file)
    saveEntries(ctx, entries.filter((e) => e.name !== name))
    log.info('custom_command.removed', 'Custom command removed', { name })
    return { ok: true, data: { name } }
  } catch (e) {
    log.error('custom_command.remove_failed', 'Could not remove custom command', { name, code: (e as NodeJS.ErrnoException).code })
    return customCommandFail('write_failed', `Could not remove the command: ${(e as Error).message}`)
  }
}
