// The one argv + env every server-side git call is built from (sec-208-2). git executes programs
// named by repo-local config (`core.fsmonitor` on status/diff-files, hooks, `diff.external`,
// textconv drivers), and a repo is content the server did not write: a cloned project, or a repo an
// agent edited from its sandbox. This process runs unsandboxed, so each call here:
//   - turns `core.fsmonitor` off and points `core.hooksPath` at /dev/null (no hook can run);
//   - adds `--no-ext-diff --no-textconv` to diff/show/log so no diff driver runs;
//   - gets the PTY-filtered env (`ptyEnv`: no root/bot token, no server `.env` keys), never
//     prompts, and drops GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/GIT_PREFIX so an inherited override
//     cannot redirect the call to another repo (a caller may set them again through `env`).
// Exception, `userHooks: true`: the user's own explicit action whose purpose includes their hooks
// (SCM panel commit/push, "Clone repository", "New project" initial commit) keeps hooks on, as VS
// Code does for a commit from its SCM view. fsmonitor stays off there too: it is never the point.
// ponytail: `filter.<driver>.clean/smudge` from repo config still runs on status/add/checkout; a
// driver name is repo-chosen, so closing it needs Workspace-Trust-style gating (later wave).
// Lock: gitExec.bun.test.ts fails on any git spawn outside this file.
import { ptyEnv } from './ptyShell'

const GIT_BIN = 'git'
const SAFE_CONFIG = ['-c', 'core.fsmonitor=false']
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null']
const DIFF_SAFE = ['--no-ext-diff', '--no-textconv']
/** Porcelain commands that run external diff / textconv drivers by default. */
const DIFF_COMMANDS = new Set(['diff', 'show', 'log'])
/** Global options that take the next argv entry as their value. */
const VALUED_GLOBALS = new Set(['-C', '-c'])
const REPO_REDIRECT_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX']

export interface GitCommandOptions {
  /** Extra env applied last (e.g. GIT_OPTIONAL_LOCKS, GIT_INDEX_FILE for a scratch index). */
  env?: Record<string, string>
  /** Base env before filtering; tests pass a fake PATH. Default `process.env`. */
  source?: NodeJS.ProcessEnv
  /** The user's explicit commit/push/clone: keep their hooks (see the file head). */
  userHooks?: boolean
}

export interface GitCommand {
  file: string
  args: string[]
  env: Record<string, string>
}

/** Index of the git subcommand in `args` (first non-option, skipping `-C dir` / `-c k=v` values). */
function subcommandAt(args: readonly string[]): number {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (VALUED_GLOBALS.has(a)) { i++; continue }
    if (!a.startsWith('-')) return i
  }
  return -1
}

/** Env for a git child: PTY-filtered, no prompt, no inherited repo redirect, then `extra`. */
export function gitEnv(extra: Record<string, string> = {}, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = { ...ptyEnv(source, { interactive: false }), GIT_TERMINAL_PROMPT: '0' }
  for (const k of REPO_REDIRECT_ENV) delete env[k]
  return { ...env, ...extra }
}

/** `{file, args, env}` for one git call; `args` is what follows `git` (global options first). */
export function gitCommand(args: readonly string[], opts: GitCommandOptions = {}): GitCommand {
  const at = subcommandAt(args)
  const sub = at >= 0 ? args[at] as string : ''
  const body = DIFF_COMMANDS.has(sub) ? [...args.slice(0, at + 1), ...DIFF_SAFE, ...args.slice(at + 1)] : [...args]
  return {
    file: GIT_BIN,
    args: [...SAFE_CONFIG, ...(opts.userHooks ? [] : NO_HOOKS), ...body],
    env: gitEnv(opts.env, opts.source),
  }
}
