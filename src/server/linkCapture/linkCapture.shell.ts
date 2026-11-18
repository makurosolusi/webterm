// Keeps `<dataDir>/bin` FIRST on PATH inside a terminal. Plain env is not enough: a login shell re-orders
// PATH after it starts (macOS `path_helper` in /etc/profile and /etc/zprofile puts /usr/bin ahead of
// everything, so `/usr/bin/open` would beat our `open` shim). Three layers, each for one way a shell starts:
//   - `-l -c <cmd>` (agents, custom commands): the command line is prefixed with a PATH assignment, which
//     runs AFTER the login rc files (`pathPrefix`);
//   - interactive zsh: ZDOTDIR points at a generated dir whose `.zshenv` restores the user's ZDOTDIR, sources
//     the user's `.zshenv` and registers a `precmd` hook (the technique kitty/iTerm shell integration use);
//   - interactive bash: an exported PROMPT_COMMAND does the same before every prompt.
// Other shells (fish, ...) keep BROWSER only. The Settings switch turns all of this off for new sessions.
import { basename, join } from 'node:path'
import { dataDir } from '../config'
import { shQuote } from '../cli/cli.launcher'

/** Env var carrying the shim dir to the hooks (a plain path, no secret). */
export const BIN_DIR_ENV = 'WEBTERM_BIN_DIR'
/** Env var that remembers the user's own ZDOTDIR while the generated one is active ("unset" = there was none). */
export const ORIG_ZDOTDIR_ENV = 'WEBTERM_ORIG_ZDOTDIR'

/** `<dataDir>/shell/zsh`: the generated ZDOTDIR. */
export const shellDir = (): string => join(dataDir(), 'shell', 'zsh')

const ZSHENV = `# webterm shell integration (generated - do not edit). Restores your ZDOTDIR, runs your own .zshenv,
# then keeps webterm's bin dir (link catcher) first on PATH before every prompt.
if [[ -n "\${${ORIG_ZDOTDIR_ENV}-}" && "\${${ORIG_ZDOTDIR_ENV}}" != unset ]]; then ZDOTDIR="\${${ORIG_ZDOTDIR_ENV}}"; else unset ZDOTDIR; fi
unset ${ORIG_ZDOTDIR_ENV}
[[ -f "\${ZDOTDIR:-$HOME}/.zshenv" ]] && source "\${ZDOTDIR:-$HOME}/.zshenv"
_webterm_path() { local d="\${${BIN_DIR_ENV}-}"; [[ -n "$d" && "\${path[1]-}" != "$d" ]] && path=("$d" "\${(@)path:#$d}"); return 0; }
_webterm_path
precmd_functions+=(_webterm_path)
`

/** Files of the generated ZDOTDIR (name -> body). */
export const shellIntegrationFiles = (): Record<string, string> => ({ '.zshenv': ZSHENV })

/** Same fix for an interactive bash, as a PROMPT_COMMAND body. */
export const BASH_PROMPT_HOOK = `case ":$PATH:" in ":\${${BIN_DIR_ENV}}:"*) ;; *) PATH="\${${BIN_DIR_ENV}}:$PATH" ;; esac`

type Shell = 'zsh' | 'bash' | 'fish' | 'posix' | 'other'
const POSIX = new Set(['sh', 'dash', 'ksh'])

/** Kind of shell by its binary name (a login-shell dash prefix is ignored). */
export function shellKind(shell: string): Shell {
  const name = basename(shell).replace(/^-/, '')
  return name === 'zsh' || name === 'bash' || name === 'fish' ? name : POSIX.has(name) ? 'posix' : 'other'
}

/** Env that makes the shell (started interactively, no command) keep `binDir` first; empty for shells without a hook. */
export function shellHookEnv(shell: string, binDir: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const kind = shellKind(shell)
  if (kind === 'zsh') return { [BIN_DIR_ENV]: binDir, ZDOTDIR: shellDir(), [ORIG_ZDOTDIR_ENV]: base.ZDOTDIR ? base.ZDOTDIR : 'unset' }
  if (kind === 'bash') return { [BIN_DIR_ENV]: binDir, PROMPT_COMMAND: base.PROMPT_COMMAND ? `${BASH_PROMPT_HOOK}; ${base.PROMPT_COMMAND}` : BASH_PROMPT_HOOK }
  return {}
}

/** Prefix for a `-l -c <cmd>` launch: puts `binDir` first AFTER the login rc files ran; '' for a shell whose syntax is unknown. */
export function pathPrefix(shell: string, binDir: string): string {
  const kind = shellKind(shell)
  if (kind === 'fish') return `set -gx PATH ${shQuote(binDir)} $PATH; `
  return kind === 'other' ? '' : `PATH=${shQuote(binDir)}:"$PATH"; export PATH; `
}
