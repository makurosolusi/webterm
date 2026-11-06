import { execFileSync } from 'node:child_process'
import { findOnPath } from './binaryOnPath'
import { ptyEnv, resolveShell } from './ptyShell'
import { createLogger } from './logs'

const log = createLogger('pty')

/** Upper bound for the login-shell run; a slow rc file must not stall the boot for long. */
export const LOGIN_SHELL_TIMEOUT_MS = 5_000
const MARK = '__WEBTERM_LOGIN_PATH__'

/**
 * PATH as the user's login shell sets it. launchd, systemd and Dock launches start webterm with a
 * minimal PATH (`/usr/bin:/bin`), so Homebrew's tmux looked missing (ops-212-4). Copied from VS Code
 * `resolveShellEnv`: run `$SHELL -ilc` once and read the value back between markers, because rc
 * files may print banners. Undefined when the shell fails or times out.
 */
export function loginShellPath(shell: string = resolveShell(undefined), env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    const out = execFileSync(shell, ['-i', '-l', '-c', `printf '%s%s%s' ${MARK} "$PATH" ${MARK}`], {
      encoding: 'utf8',
      env: ptyEnv(env, { interactive: false }),
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: LOGIN_SHELL_TIMEOUT_MS,
    })
    return out.split(MARK)[1] || undefined
  } catch (err) {
    log.warn('pty.login_path_failed', 'Login shell PATH could not be resolved; probing the process PATH only', { code: (err as { status?: number }).status })
    return undefined
  }
}

/** Absolute path of `name`: the process PATH first, then the login shell's PATH (run only on a miss). */
export function locateBinary(name: string, pathEnv: string | undefined, loginPath: () => string | undefined = loginShellPath): string | undefined {
  return findOnPath(name, pathEnv ?? '') ?? findOnPath(name, loginPath() ?? '')
}
