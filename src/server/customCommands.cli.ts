// `webterm command list|add|remove|which|detect` for a person at a terminal: runs directly on the data
// dir (like --reset-password), so the server need not be running. Agent sessions use the capability
// bindings instead (cli.customCommands.ts) and are gated by policy + the human-UI-only routes.
import type { CustomCommandAddRequest, CustomCommandStatus } from '../shared/customCommands'
import { detectCommands } from './customCommands.detect'
import { addPathDir, listPaths, removePathDir } from './customCommands.paths'
import { addCommand, listCommands, removeCommand, whichCommand, type CustomCommandsCtx } from './customCommands.store'
import { scanToolDirs } from './pathResolver'

export const COMMAND_USAGE = `usage: webterm command <verb>
  list [--json]                         registered custom commands and their status
  add <name> --link <abs-path>          symlink a command to an existing executable
  add <name> --shim [--note <t>] -- <program> [args...]
                                        a command that runs a fixed argv, then your own args
                                        (flags: --force replaces an entry / the "claude" name)
  remove <name>                         unregister and delete the command file
  which <name>                          where <name> resolves, using the managed PATH
  detect                                every tool in the managed + extra dirs and the common wrappers on PATH
                                        (format, platform fit); all of them already work in terminals, add is optional
  path list|add <dir>|remove <dir>      extra tool folders: every program inside is found in all terminals
  rescan                                look for freshly installed tools now (a running server also does this on its own
                                        the first time a command is not found; use Rescan in Settings for an instant refresh)

A folder may hold builds for several machines in <os>-<arch> subfolders (darwin-arm64, linux-amd64, ...):
the one matching this machine is searched first, so the same folder works on the host and in Docker.`

export interface CommandIo { out(text: string): void; err(text: string): void }

const line = (s: CustomCommandStatus): string =>
  `${s.name.padEnd(20)} ${s.kind.padEnd(4)} ${s.found ? 'found  ' : 'MISSING'} ${s.resolved ?? '-'}${s.shadows ? `  (replaces ${s.shadows})` : ''}`

/** Parses `add` args; the shim argv is everything after `--`. */
export function parseAdd(args: readonly string[]): CustomCommandAddRequest | string {
  const [name, ...rest] = args
  if (!name || name.startsWith('-')) return 'add needs a command name first'
  const req: { name: string; kind?: 'link' | 'shim'; target?: string; argv?: string[]; note?: string; force?: boolean } = { name }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--') { req.argv = rest.slice(i + 1); break }
    if (a === '--force') req.force = true
    else if (a === '--shim') req.kind = 'shim'
    else if (a === '--link' || a === '--note') {
      const v = rest[++i]
      if (v === undefined) return `${a} needs a value`
      if (a === '--link') { req.kind = 'link'; req.target = v } else req.note = v
    } else return `unknown option '${a}'`
  }
  if (!req.kind) return 'add needs --link <path> or --shim -- <argv...>'
  return req as CustomCommandAddRequest
}

/** Runs one verb; returns the exit code (0 ok, 1 refused, 2 usage). */
export function runCommandCli(args: readonly string[], ctx: CustomCommandsCtx, io: CommandIo): number {
  const [verb, ...rest] = args
  try {
    switch (verb) {
      case 'list': {
        const all = listCommands(ctx)
        io.out(rest.includes('--json') ? `${JSON.stringify(all, null, 2)}\n` : all.length ? `${all.map(line).join('\n')}\n` : 'No custom commands registered.\n')
        return 0
      }
      case 'add': {
        const req = parseAdd(rest)
        if (typeof req === 'string') { io.err(`webterm: ${req}\n${COMMAND_USAGE}\n`); return 2 }
        const r = addCommand(ctx, req)
        if (!r.ok) { io.err(`webterm: ${r.message} (${r.code})\n`); return 1 }
        io.out(`Added ${r.data.name} (${r.data.kind}) -> ${r.data.resolved ?? 'not found yet'}\n`)
        if (r.data.shadows) io.out(`Warning: this replaces ${r.data.shadows} in webterm terminals.\n`)
        if (!r.data.found) io.out('Warning: the program was not found on PATH; the command fails until it is installed.\n')
        return 0
      }
      case 'remove': {
        if (!rest[0]) { io.err(`webterm: remove needs a command name\n${COMMAND_USAGE}\n`); return 2 }
        const r = removeCommand(ctx, rest[0])
        if (!r.ok) { io.err(`webterm: ${r.message} (${r.code})\n`); return 1 }
        io.out(`Removed ${r.data.name}\n`)
        return 0
      }
      case 'which': {
        if (!rest[0]) { io.err(`webterm: which needs a command name\n${COMMAND_USAGE}\n`); return 2 }
        const w = whichCommand(ctx, rest[0])
        io.out(w.path ? `${w.path}${w.custom ? '  (custom command)' : ''}\n` : `${w.name} not found\n`)
        return w.path ? 0 : 1
      }
      case 'detect':
        io.out(`${detectCommands(ctx).map((d) => `${d.name.padEnd(16)} ${(d.found ? d.source : 'not found').padEnd(10)} ${d.found ? `${d.format}/${d.compat}  ${d.path}` : ''}${d.compatMessage ? `\n    ! ${d.compatMessage}` : ''}`.trimEnd()).join('\n')}\n`)
        return 0
      case 'path': {
        const [sub, dir] = rest
        if (sub === 'list' || sub === undefined) {
          const v = listPaths(ctx)
          io.out(`managed: ${v.managed} (+ ${v.platformDir}/)\n${v.extra.length ? v.extra.map((e) => `extra:   ${e.dir}${e.exists ? '' : '  (missing)'}${e.safe ? '' : '  (UNSAFE: world-writable, ignored)'}`).join('\n') : 'extra:   (none)'}\n`)
          return 0
        }
        if ((sub !== 'add' && sub !== 'remove') || !dir) { io.err(`webterm: path needs list | add <dir> | remove <dir>\n${COMMAND_USAGE}\n`); return 2 }
        const r = sub === 'add' ? addPathDir(ctx, dir) : removePathDir(ctx, dir)
        if (!r.ok) { io.err(`webterm: ${r.message} (${r.code})\n`); return 1 }
        io.out(`${sub === 'add' ? 'Added' : 'Removed'} ${dir}\n`)
        return 0
      }
      case 'rescan': {
        const added = scanToolDirs()
        io.out(`Scanned the usual tool folders (${added} new on this shell's PATH). A running webterm server re-scans on its own the first time a command is not found, or at once with Rescan in Settings.\n`)
        return 0
      }
      default:
        io.err(`${COMMAND_USAGE}\n`)
        return 2
    }
  } catch (e) {
    io.err(`webterm: ${(e as Error).message}\n`)
    return 1
  }
}
