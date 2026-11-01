// Server-owned command configuration for the verifier (QC M4). Nothing here is derived from a
// worker payload: the executable must be on the allowlist and the argv is fixed, so task/plan text
// can never become a command (and there is no shell to interpolate into).
//
// Resolution problems are returned as data; `VerifyError` lives in `verify.ts` to avoid a cycle.

export type CheckId = 'test' | 'typecheck' | 'lint'

export interface ConfiguredCommand {
  file: string
  args: string[]
}

export const MAX_ARGS = 64
export const MAX_ARG_LENGTH = 500
export const DEFAULT_EXECUTABLES = ['npm', 'pnpm', 'yarn', 'bun', 'npx', 'node'] as const
export const DEFAULT_COMMANDS: Record<CheckId, ConfiguredCommand> = {
  test: { file: 'npm', args: ['test'] },
  typecheck: { file: 'npm', args: ['run', 'typecheck'] },
  lint: { file: 'npm', args: ['run', 'lint'] },
}
/** Argv tetap, tidak pernah diambil dari task/plan, jadi tidak ada interpolasi data task. */
export const GIT_COMMANDS = {
  status: ['status', '--porcelain'],
  names: ['diff', '--name-only'],
  diffStat: ['diff', '--stat'],
} as const

export type CommandResolution =
  | { ok: true; command: ConfiguredCommand }
  | { ok: false; message: string }

/** Configured executable must be allowlisted and its argv clean; anything else is rejected. */
export function resolveCommand(
  id: CheckId,
  configured: ConfiguredCommand | undefined,
  allowed: readonly string[]
): CommandResolution {
  const command = configured ?? DEFAULT_COMMANDS[id]
  if (!command || typeof command.file !== 'string' || !allowed.includes(command.file)) {
    return {
      ok: false,
      message: `${id} command rejected: executable ${JSON.stringify(command?.file)} is not allowlisted`,
    }
  }
  if (!Array.isArray(command.args) || command.args.length > MAX_ARGS) {
    return { ok: false, message: `${id} command rejected: unsupported argument list` }
  }
  for (const arg of command.args) {
    if (typeof arg !== 'string' || arg.length > MAX_ARG_LENGTH || /[\u0000-\u001f]/.test(arg)) {
      return { ok: false, message: `${id} command rejected: invalid argument` }
    }
  }
  return { ok: true, command: { file: command.file, args: [...command.args] } }
}
