// Contract for user-registered custom commands (shared by server, CLI and, later, the client wizard).
// Pure: no I/O. The server owns files and PATH; this file owns names, limits and the shim text.

export const CUSTOM_COMMANDS_PATH = '/api/custom-commands'
export const CUSTOM_COMMAND_MAX_ENTRIES = 64
export const CUSTOM_COMMAND_ARGV_MAX = 32
export const CUSTOM_COMMAND_ARG_MAX_CHARS = 512
export const CUSTOM_COMMAND_NOTE_MAX_CHARS = 200
export const CUSTOM_COMMAND_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** Names no custom command may take, even with `force`: shells and core system tools. */
export const CUSTOM_COMMAND_DENIED_NAMES: readonly string[] = [
  'sh', 'bash', 'zsh', 'fish', 'ls', 'cat', 'rm', 'cp', 'mv', 'sudo', 'su', 'ssh', 'git', 'tmux', 'bun', 'node', 'npm', 'webterm',
]
/** Names that are allowed only with `force` (a deliberate wrapper around the real tool). */
export const CUSTOM_COMMAND_FORCE_NAMES: readonly string[] = ['claude']

/** Executable format read from the header (never by running it), and whether it fits this machine's os/arch. */
export type CustomCommandFormat = 'elf' | 'macho' | 'pe' | 'script' | 'unknown'
export type CustomCommandCompat = 'ok' | 'wrong_platform' | 'wrong_arch' | 'unknown'
export interface CustomCommandBinaryInfo { format: CustomCommandFormat; compat: CustomCommandCompat; compatMessage: string | null }

export type CustomCommandKind = 'link' | 'shim'

/** One stored registration. `link` has `target`; `shim` has `argv`. Never holds env values or secrets. */
export interface CustomCommandEntry {
  name: string
  kind: CustomCommandKind
  target?: string
  argv?: string[]
  note?: string
  addedAt: number
}

export interface CustomCommandStatus extends CustomCommandEntry, CustomCommandBinaryInfo {
  /** Target (link) or first argv word (shim) exists and is executable. Never executed to find out. */
  found: boolean
  /** Absolute path the command resolves to, or null when missing. */
  resolved: string | null
  /** Path of a different executable of the same name that this command replaces on PATH, or null. */
  shadows: string | null
}

export interface CustomCommandAddRequest {
  name: string
  kind: CustomCommandKind
  target?: string
  argv?: string[]
  note?: string
  /** Allows replacing an existing entry and the force-only names (claude). */
  force?: boolean
}

/** Where a detected tool lives: the managed dir, a user extra dir, a PATH dir, or a known wrapper not installed. */
export type CustomCommandSource = 'custom-bin' | 'extra' | 'path' | 'candidate'
export interface CustomCommandDetected extends CustomCommandBinaryInfo { name: string; path: string | null; found: boolean; source: CustomCommandSource }

export const CUSTOM_COMMAND_MAX_PATH_DIRS = 16

/** Stable error codes; the HTTP layer maps them (invalid_* / reserved_name 400, duplicate / limit_reached 409, ...). */
export type CustomCommandErrorCode =
  | 'invalid_name' | 'reserved_name' | 'invalid_kind' | 'invalid_target' | 'invalid_argv' | 'invalid_note'
  | 'invalid_path_dir' | 'unsafe_path_dir' | 'duplicate' | 'limit_reached' | 'not_found' | 'bin_dir_readonly' | 'write_failed'

export interface CustomCommandFailure { ok: false; code: CustomCommandErrorCode; message: string }
export type CustomCommandResult<T> = { ok: true; data: T } | CustomCommandFailure

export const customCommandFail = (code: CustomCommandErrorCode, message: string): CustomCommandFailure => ({ ok: false, code, message })

/** Valid when `ok`. `force` unlocks the force-only names. */
export function validateCustomCommandName(name: unknown, force = false): CustomCommandResult<string> {
  if (typeof name !== 'string' || !CUSTOM_COMMAND_NAME_RE.test(name)) {
    return customCommandFail('invalid_name', 'Name must be 1-64 chars: lowercase letters, digits, ".", "_" or "-", starting with a letter or digit.')
  }
  if (CUSTOM_COMMAND_DENIED_NAMES.includes(name)) return customCommandFail('reserved_name', `"${name}" is a core system command and cannot be replaced.`)
  if (CUSTOM_COMMAND_FORCE_NAMES.includes(name) && !force) return customCommandFail('reserved_name', `"${name}" replaces a tool webterm launches; pass force to do that on purpose.`)
  return { ok: true, data: name }
}

/** An argv is 1-32 strings of at most 512 chars, no NUL, and a non-empty first word (the program). */
export function validateCustomCommandArgv(argv: unknown): CustomCommandResult<string[]> {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > CUSTOM_COMMAND_ARGV_MAX) {
    return customCommandFail('invalid_argv', `argv must hold 1-${CUSTOM_COMMAND_ARGV_MAX} strings.`)
  }
  for (const a of argv) {
    if (typeof a !== 'string' || a.length > CUSTOM_COMMAND_ARG_MAX_CHARS || a.includes('\0')) {
      return customCommandFail('invalid_argv', `Each argv item must be a string of at most ${CUSTOM_COMMAND_ARG_MAX_CHARS} chars without NUL.`)
    }
  }
  if (argv[0] === '') return customCommandFail('invalid_argv', 'The first argv item (the program) must not be empty.')
  return { ok: true, data: argv as string[] }
}

/** Single-quote one word for sh; the only escape needed inside single quotes is the quote itself. */
export const shQuoteWord = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * The shim script: `exec <argv...> "$@"`. Every word is single-quoted, so input text is never
 * interpreted by the shell (no eval, no expansion). When the shim's own name is among the words
 * (e.g. `claude` wrapping `claude`), the managed bin dir is dropped from PATH first, otherwise the
 * shim would find itself and loop forever.
 */
export function renderShim(name: string, argv: readonly string[], binDir: string): string {
  const lines = ['#!/bin/sh', `# webterm custom command "${name.replace(/[^a-z0-9._-]/g, '?')}" (managed by webterm; edits are overwritten)`]
  if (argv.includes(name)) {
    lines.push(
      `d=${shQuoteWord(binDir)}; p=; IFS=:`,
      'for e in $PATH; do [ "$e" = "$d" ] || p="${p:+$p:}$e"; done',
      'unset IFS; PATH=$p; export PATH',
    )
  }
  lines.push(`exec ${argv.map(shQuoteWord).join(' ')} "$@"`, '')
  return lines.join('\n')
}
