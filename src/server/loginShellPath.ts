import { execFileSync } from 'node:child_process'
import { delimiter } from 'node:path'
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

/** `current` followed by the entries of `extra` it lacks; empty entries dropped, first occurrence kept. */
export function mergePathLists(current: string, extra: string): { path: string; added: number } {
  const have = current.split(delimiter).filter(Boolean)
  const merged = [...new Set([...have, ...extra.split(delimiter).filter(Boolean)])]
  return { path: merged.join(delimiter), added: merged.length - new Set(have).size }
}

/**
 * Once at boot, before anything spawns: append the login shell's PATH entries that `env.PATH` lacks,
 * the way VS Code resolves the shell env at startup. Every later PATH reader (tmux probe, launch
 * profile Test, headless claude spawns, agent sessions) then sees `~/.local/bin`, Homebrew and nvm
 * directories even when launchd/Dock/ssh started webterm with `/usr/bin:/bin`. No-op on Windows.
 * Returns how many entries were added.
 */
export function mergeLoginShellPath(
  env: NodeJS.ProcessEnv = process.env,
  resolve: () => string | undefined = () => loginShellPath(undefined, env),
  platform: string = process.platform
): number {
  if (platform === 'win32') return 0
  const login = resolve()
  if (login === undefined) return 0
  const { path, added } = mergePathLists(env.PATH ?? '', login)
  if (added > 0) env.PATH = path
  // Count only: PATH entries carry user names.
  log.info('pty.login_path_merged', 'Merged the login shell PATH into the server PATH', { added })
  return added
}
