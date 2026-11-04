// Is Claude Code's input box EMPTY right now? Read from the agent's SCREEN (rendered server-side by
// `linkNoteScreen.ts`), because nothing else proves it: an idle hook only says the turn ended, not
// that the user is not halfway through typing the next prompt. A link note typed into a draft would
// be submitted together with the user's half-typed text.
//
// PORTED from nodeterm `src/shared/agents/claude-screen.ts:34-188` (readClaudeScreen +
// readClaudeComposer, measured on Claude Code 2.1.283/2.1.301; same licensor, BUSL-1.1). Logic kept
// as-is; only the export surface was narrowed to the one reader webterm uses.
//
// Measured screen: a `────` rule, a line starting `❯ ` (or `!` in shell mode), another rule, then
// status lines. An empty composer shows a DIM placeholder (`❯ Try "…"` in SGR 2); typed text is not
// dim. Dialogs replace or sit above the box and end in a key-hint footer ("Enter to confirm",
// "Esc to cancel"). The reader fails CLOSED: what it cannot prove empty is never `empty`.

/** `empty` = live input box holding only dim placeholder; `draft` = anything typed; `no-prompt` =
 *  dialog or no box on screen; `unknown` = nothing readable. */
export type ClaudeComposer = 'empty' | 'draft' | 'no-prompt' | 'unknown'

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

/** A full-width rule of the input box (`─`, U+2500). */
const isRule = (line: string): boolean => /^─{20,}/.test(line.trim())
/** A key-hint footer. Capitalized on purpose: the working spinner says "esc to interrupt". */
const isFooter = (line: string): boolean => {
  const t = line.trim()
  return /^Enter to confirm\b/.test(t) || /(?:^|\s·\s)Esc to (?:cancel|exit|go back)$/.test(t)
}

/** Non-blank lines allowed under the box's bottom rule (status lines). */
const BOX_TAIL_LINES = 8
/** A footer with no box: a dialog's key hints are its last line. */
const FOOTER_TAIL_LINES = 3
/** A footer above a live box: a dialog drawn right on top of the input box. */
const FOOTER_ABOVE_BOX_LINES = 4

/** The input box's first line: `❯`, or `!` in shell mode (followed by U+00A0, which `\s` covers). */
const isPromptLine = (line: string | undefined): boolean =>
  line !== undefined && (line.startsWith('❯') || /^!(\s|$)/.test(line))

/** Indexes of the non-blank lines, bottom first. */
const nonBlankFromBottom = (lines: readonly string[]): number[] =>
  lines.flatMap((l, i) => (l.trim() === '' ? [] : [i])).reverse()

/** The live input box: `[top rule, bottom rule]` line indexes, or null. */
function inputBox(lines: readonly string[]): [number, number] | null {
  const tail = nonBlankFromBottom(lines).slice(0, BOX_TAIL_LINES + 1)
  for (const bottom of tail) {
    if (bottom === 0 || !isRule(lines[bottom])) continue
    for (let top = bottom - 1; top >= 0 && bottom - top <= 40; top--) {
      if (!isRule(lines[top])) continue
      return isPromptLine(lines[top + 1]) && top + 1 < bottom ? [top, bottom] : null
    }
    return null
  }
  return null
}

/** Does the screen show the input box with no dialog footer owning the keyboard? */
function showsPrompt(lines: readonly string[]): boolean {
  const box = inputBox(lines)
  const bottom = nonBlankFromBottom(lines)
  const candidates = box
    ? [...bottom.filter((i) => i > box[1]), ...bottom.filter((i) => i < box[0]).slice(0, FOOTER_ABOVE_BOX_LINES)]
    : bottom.slice(0, FOOTER_TAIL_LINES)
  if (candidates.some((i) => isFooter(lines[i]))) return false
  return box !== null
}

/** The dim flag after one SGR sequence's parameters; extended colours consume their arguments. */
function applySgrDim(params: string, dim: boolean): boolean {
  const ps = params === '' ? ['0'] : params.split(/[;:]/)
  for (let k = 0; k < ps.length; k++) {
    const p = ps[k] === '' ? 0 : Number(ps[k])
    if (p === 38 || p === 48 || p === 58) {
      const mode = Number(ps[k + 1])
      k += mode === 5 ? 2 : mode === 2 ? 4 : 1
    } else if (p === 0 || p === 22) dim = false
    else if (p === 2) dim = true
  }
  return dim
}

/** Does any visible, non-blank character of this styled line (from plain-text column `from`) sit
 *  outside SGR dim? */
function hasUndimmedText(styled: string, from: number): boolean {
  let dim = false
  let col = 0
  let i = 0
  while (i < styled.length) {
    if (styled[i] === '\x1b') {
      const csi = /^\x1b\[([0-?]*)([ -/]*)([@-~])/.exec(styled.slice(i))
      if (csi) {
        if (csi[3] === 'm') dim = applySgrDim(csi[1], dim)
        i += csi[0].length
        continue
      }
      // eslint-disable-next-line no-control-regex
      const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(styled.slice(i))
      i += osc ? osc[0].length : 1
      continue
    }
    const ch = String.fromCodePoint(styled.codePointAt(i)!)
    if (col >= from && ch.trim() !== '' && !dim) return true
    col += ch.length
    i += ch.length
  }
  return false
}

/** Read a STYLED screen (lines joined by `\n`, SGR kept) and say whether the composer is empty. */
export function readClaudeComposer(styledScreen: string): ClaudeComposer {
  const styled = styledScreen.split(/\r?\n/)
  const lines = styled.map((l) => l.replace(ANSI, '').trimEnd())
  if (lines.every((l) => l === '')) return 'unknown'
  if (!showsPrompt(lines)) return 'no-prompt'
  const box = inputBox(lines)
  if (!box) return 'no-prompt'
  const promptAt = box[0] + 1
  const prompt = lines[promptAt]
  if (!prompt.startsWith('❯')) return 'draft'
  for (let i = promptAt + 1; i < box[1]; i++) if (lines[i].trim() !== '') return 'draft'
  return hasUndimmedText(styled[promptAt], 1) ? 'draft' : 'empty'
}

/** The plain text of the composer's prompt line (after `❯`), or null when no box is on screen. Used
 *  to see that a typed note actually landed before its Enter is sent. */
export function composerText(styledScreen: string): string | null {
  const lines = styledScreen.split(/\r?\n/).map((l) => l.replace(ANSI, '').trimEnd())
  const box = inputBox(lines)
  return box ? lines[box[0] + 1].replace(/^[❯!]\s?/, '') : null
}
