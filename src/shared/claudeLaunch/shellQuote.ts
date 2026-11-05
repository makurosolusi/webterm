// POSIX tokenizer + quoter, copied from nodeterm `src/shared/shell-quote.ts` (shellSingleQuote,
// shellQuoteIfNeeded, shellSplit; `argvHasFlag` left out until something here needs it).

/** Single-quote a string for safe use as one shell argument (POSIX). */
export function shellSingleQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

/** Tokens made only of these characters mean the same thing bare and quoted. */
const SAFE_BARE_TOKEN = /^[A-Za-z0-9_@%+=:,.^/-]+$/

/** Quote `s` as one shell argument only if it needs it. */
export function shellQuoteIfNeeded(s: string): string {
  return s !== '' && SAFE_BARE_TOKEN.test(s) ? s : shellSingleQuote(s)
}

/** argv -> one shell line where every token stays exactly one argument. */
export const joinArgv = (argv: readonly string[]): string => argv.map(shellQuoteIfNeeded).join(' ')

/**
 * Split a free-text command into tokens the way a POSIX shell would (single/double quotes,
 * backslash escapes). Deliberately NOT a shell: no variable expansion, no substitution, no tilde.
 */
export function shellSplit(input: string): string[] {
  const tokens: string[] = []
  let buf = ''
  let inSingle = false
  let inDouble = false
  let hasToken = false
  const push = (): void => {
    if (hasToken) tokens.push(buf)
    buf = ''
    hasToken = false
  }
  for (let i = 0; i < input.length; i++) {
    const c = input[i] as string
    if (inSingle) {
      if (c === "'") inSingle = false
      else buf += c
    } else if (inDouble) {
      if (c === '\\' && input[i + 1] !== undefined) buf += input[++i]
      else if (c === '"') inDouble = false
      else buf += c
    } else if (c === '\\' && input[i + 1] !== undefined) {
      buf += input[++i]
      hasToken = true
    } else if (c === "'") {
      inSingle = true
      hasToken = true
    } else if (c === '"') {
      inDouble = true
      hasToken = true
    } else if (/\s/.test(c)) {
      push()
    } else {
      buf += c
      hasToken = true
    }
  }
  push()
  return tokens
}
