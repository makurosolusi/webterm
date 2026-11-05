// Human-error normalisation of a Claude launch command (Settings > Agent > Claude launch profiles).
// Pure: the client shows the warnings inline, the server launches the normalised argv.
import { joinArgv, shellSplit } from './shellQuote'

export interface NormalizedLaunch {
  /** What actually runs: wrapper argv + claude + claude flags. Never empty. */
  argv: string[]
  warnings: string[]
  /** Corrected command text for one-click "Apply fix"; absent when nothing needs fixing. */
  suggestion?: string
}

export const CLAUDE_BIN = 'claude'
const DASHDASH = '--'

/** Wrappers that run the command after a bare `--` and misread it without one. */
const DASH_WRAPPERS: readonly (readonly string[])[] = [['envman'], ['op', 'run'], ['doppler', 'run']]
/** `env` options that take a value as the next token. */
const ENV_ARG_OPTS = new Set(['-u', '--unset', '-C', '--chdir'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const SHELL_OPS = new Set(['&&', '||', '|', ';', '&', '>', '>>', '<'])

const baseName = (t: string): string => t.slice(t.lastIndexOf('/') + 1)
export const isClaudeToken = (t: string | undefined): boolean => t !== undefined && baseName(t) === CLAUDE_BIN

const TEXT = {
  prompt: 'Removed a leading "$" (a copied shell prompt).',
  dashDash: (w: string): string => `${w} needs "--" before the command it runs.`,
  addClaude: 'Added "claude" before its flags.',
  doubled: 'Removed a repeated "claude".',
  shell: 'Shell syntax ($VAR, |, &&, ;) is not interpreted here. Put it in a script and use the script as the command.',
  tilde: '"~" is not expanded here. Use the full path.',
  secret: 'This looks like a secret typed into the command. Settings are not a secret store: let a wrapper such as envman inject it.',
}
const SECRET_ASSIGNMENT = /^[A-Za-z_]*(KEY|TOKEN|SECRET|PASSWORD|AUTH)[A-Za-z0-9_]*=./i

function dashWrapper(t: readonly string[]): string | null {
  const hit = DASH_WRAPPERS.find((w) => w.every((part, i) => (i === 0 ? baseName(t[0] ?? '') : t[i]) === part))
  return hit ? hit.join(' ') : null
}

/** Index where the wrapped command starts; `t.length` when it is missing; 0 for a bare launcher. */
export function commandIndex(t: readonly string[]): number {
  if (isClaudeToken(t[0])) return 0
  const sep = t.indexOf(DASHDASH)
  if (sep >= 0) return sep + 1
  if (baseName(t[0] ?? '') === 'env') {
    let i = 1
    while (i < t.length) {
      const x = t[i] as string
      if (ENV_ARG_OPTS.has(x)) i += 2
      else if (x.startsWith('-') || ASSIGNMENT.test(x)) i += 1
      else break
    }
    return Math.min(i, t.length)
  }
  if (baseName(t[0] ?? '') === 'direnv' && t[1] === 'exec') return Math.min(3, t.length)
  return 0 // a custom launcher script: it is the command itself
}

/** Normalise free text into the argv that will run. Empty = Default (`claude`). */
export function normalizeClaudeCommand(input: string): NormalizedLaunch {
  const warnings: string[] = []
  let fixed = false
  let t = shellSplit(input.trim())
  const original = joinArgv(t)
  if (t[0] === '$') { t = t.slice(1); warnings.push(TEXT.prompt); fixed = true }
  if (t.length === 0) return { argv: [CLAUDE_BIN], warnings }
  if (t.some((x) => SHELL_OPS.has(x) || x.includes('$') || x.includes('`'))) warnings.push(TEXT.shell)
  if (t.some((x) => x.startsWith('~'))) warnings.push(TEXT.tilde)
  if (t.some((x) => SECRET_ASSIGNMENT.test(x))) warnings.push(TEXT.secret)

  const wrapper = dashWrapper(t)
  if (wrapper && !t.includes(DASHDASH)) {
    const k = t.findIndex(isClaudeToken)
    t = k > 0 ? [...t.slice(0, k), DASHDASH, ...t.slice(k)] : [...t, DASHDASH]
    warnings.push(TEXT.dashDash(wrapper))
    fixed = true
  }
  const at = commandIndex(t)
  // Prefix form (`envman -e x --`, `env FOO=1`): the command is implied. Not an error.
  if (at === t.length) t = [...t, CLAUDE_BIN]
  else if (at > 0 && (t[at] as string).startsWith('-')) {
    t = [...t.slice(0, at), CLAUDE_BIN, ...t.slice(at)]
    warnings.push(TEXT.addClaude)
    fixed = true
  }
  let doubled = false
  while (isClaudeToken(t[at]) && isClaudeToken(t[at + 1])) { t = [...t.slice(0, at), ...t.slice(at + 1)]; doubled = true }
  if (doubled) { warnings.push(TEXT.doubled); fixed = true }

  const suggestion = fixed && joinArgv(t) !== original ? joinArgv(t) : undefined
  return { argv: t, warnings, ...(suggestion !== undefined ? { suggestion } : {}) }
}

/** argv split into the wrapper part, the claude binary and claude's own flags. */
export function splitLaunch(argv: readonly string[]): { wrapper: string[]; bin: string; flags: string[] } {
  const at = Math.min(commandIndex(argv), argv.length - 1)
  return { wrapper: argv.slice(0, at), bin: argv[at] as string, flags: argv.slice(at + 1) }
}
