// Shell word quoting and splitting for launch command lines, following the POSIX sh quoting rules
// (Shell Command Language §2.2): inside single quotes everything is literal and a single quote
// cannot appear, so it is written as close-quote, backslash-quote, reopen-quote.

const QUOTE = "'"
/** Characters that never need quoting: a word made only of these reads the same bare or quoted. */
const PLAIN_WORD = /^[A-Za-z0-9_@%+=:,.^/-]+$/

/** Wrap `text` in single quotes so a POSIX shell reads it back as exactly one literal word. */
export function shellSingleQuote(text: string): string {
  return QUOTE + text.split(QUOTE).join(`${QUOTE}\\${QUOTE}${QUOTE}`) + QUOTE
}

/** Quote `text` as one shell word only when leaving it bare would change its meaning. */
export function shellQuoteIfNeeded(text: string): string {
  return PLAIN_WORD.test(text) ? text : shellSingleQuote(text)
}

/** Join argv into one shell line in which every element stays exactly one argument. */
export const joinArgv = (argv: readonly string[]): string => argv.map(shellQuoteIfNeeded).join(' ')

/**
 * Split a free-text command into words like a POSIX shell would (single quotes, double quotes,
 * backslash escapes). It is NOT a shell: no variable, command or tilde expansion happens.
 */
export function shellSplit(input: string): string[] {
  return tokenize(input).words
}

/** True when a quote is opened and never closed (the rest of the input would be swallowed as one word). */
export const hasUnclosedQuote = (input: string): boolean => tokenize(input).unterminated

type Mode = 'bare' | 'single' | 'double'

function tokenize(input: string): { words: string[]; unterminated: boolean } {
  const words: string[] = []
  let mode: Mode = 'bare'
  let word = ''
  let started = false // an empty pair of quotes still makes a word

  const endWord = (): void => {
    if (started) words.push(word)
    word = ''
    started = false
  }

  const chars = Array.from(input)
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string
    const next = chars[i + 1]
    if (mode === 'single') {
      if (ch === QUOTE) mode = 'bare'
      else word += ch
    } else if (mode === 'double') {
      if (ch === '"') mode = 'bare'
      else if (ch === '\\' && next !== undefined) word += chars[++i]
      else word += ch
    } else if (ch === '\\' && next !== undefined) {
      word += chars[++i]
      started = true
    } else if (ch === QUOTE || ch === '"') {
      mode = ch === QUOTE ? 'single' : 'double'
      started = true
    } else if (/\s/.test(ch)) {
      endWord()
    } else {
      word += ch
      started = true
    }
  }
  endWord()
  return { words, unterminated: mode !== 'bare' }
}
