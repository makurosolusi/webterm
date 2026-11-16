// Decide from the rendered terminal screen whether Claude Code's input box is empty, so a link note is
// never typed on top of a half-written prompt. The screen is the only trustworthy source: an idle hook
// says the turn ended, not that the user has stopped typing. The verdict fails CLOSED: anything that
// cannot be proven empty is not reported as `empty`.
//
// Screen anatomy this reader relies on (observed on Claude Code 2.1.x): a horizontal rule, the prompt
// row (`❯ ...`, or `! ...` in shell mode), another rule, then a few status rows. An empty box shows a
// placeholder drawn with SGR dim (`ESC[2m`); real input is not dim. A dialog hides or overlays the box
// and ends with a key-hint footer ("Enter to confirm", "Esc to cancel").

/** `empty`: box holds only the dim placeholder. `draft`: something was typed. `no-prompt`: a dialog
 *  owns the screen or there is no box. `unknown`: nothing to read. */
export type ClaudeComposer = 'empty' | 'draft' | 'no-prompt' | 'unknown'

/** Rows (non-blank) examined under the box, above it for an overlaid dialog, and for a boxless dialog. */
const STATUS_ROWS_BELOW = 8
const DIALOG_ROWS_ABOVE_BOX = 4
const DIALOG_ROWS_NO_BOX = 3
/** Furthest the top rule may sit above the bottom rule. */
const MAX_BOX_HEIGHT = 40

// Escape sequences with no visible width: CSI (`ESC [ ... final`) and OSC (`ESC ] ... BEL|ST`).
// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const stripEscapes = (s: string): string => s.replace(ESCAPES, '')
const plainRows = (screen: string): string[] => screen.split(/\r?\n/).map((r) => stripEscapes(r).trimEnd())

const isRule = (row: string): boolean => /^─{20,}/.test(row.trim())
const isPromptRow = (row: string | undefined): row is string => row !== undefined && (row.startsWith('❯') || /^!(\s|$)/.test(row))
// Capitalised on purpose: the busy spinner's hint is lowercase "esc to interrupt".
const isDialogFooter = (row: string): boolean => /^Enter to confirm\b/.test(row.trim()) || /(?:^|\s·\s)Esc to (?:cancel|exit|go back)$/.test(row.trim())

/** Indexes of non-blank rows, last row first. */
function filledRowsBottomUp(rows: readonly string[]): number[] {
  const out: number[] = []
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].trim() !== '') out.push(i)
  return out
}

/** Row indexes `[topRule, bottomRule]` of the live input box, or null when the screen has none. */
function findBox(rows: readonly string[]): [number, number] | null {
  const bottom = filledRowsBottomUp(rows).slice(0, STATUS_ROWS_BELOW + 1).find((i) => i > 0 && isRule(rows[i]))
  if (bottom === undefined) return null
  for (let top = bottom - 1; top >= 0 && bottom - top <= MAX_BOX_HEIGHT; top--) {
    if (isRule(rows[top])) return top + 1 < bottom && isPromptRow(rows[top + 1]) ? [top, bottom] : null
  }
  return null
}

/** True when a dialog footer sits where a dialog would be drawn relative to the box (or the screen end). */
function dialogOwnsKeyboard(rows: readonly string[], box: [number, number]): boolean {
  const filled = filledRowsBottomUp(rows)
  const watched = [...filled.filter((i) => i > box[1]), ...filled.filter((i) => i < box[0]).slice(0, DIALOG_ROWS_ABOVE_BOX)]
  return watched.some((i) => isDialogFooter(rows[i]))
}

/** Dim state after one SGR parameter list; 38/48/58 swallow their colour arguments. */
function nextDim(params: string, dim: boolean): boolean {
  const codes = (params === '' ? '0' : params).split(/[;:]/)
  for (let k = 0; k < codes.length; k++) {
    const code = codes[k] === '' ? 0 : Number(codes[k])
    if (code === 38 || code === 48 || code === 58) k += Number(codes[k + 1]) === 5 ? 2 : Number(codes[k + 1]) === 2 ? 4 : 1
    else if (code === 0 || code === 22) dim = false
    else if (code === 2) dim = true
  }
  return dim
}

/** Does this raw (SGR-bearing) row have a visible, non-blank glyph after its first one that is NOT dim? */
function hasBrightTextAfterPrompt(row: string): boolean {
  let dim = false
  let seen = 0
  // Tokens: a CSI (groups 1-2), an OSC or lone ESC (skipped), or a run of visible text (group 3).
  const token = /\x1b\[([0-?]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b|([^\x1b]+)/gy // eslint-disable-line no-control-regex
  for (let m = token.exec(row); m !== null; m = token.exec(row)) {
    if (m[3] === undefined) {
      if (m[2] === 'm') dim = nextDim(m[1], dim)
      continue
    }
    for (const glyph of m[3]) {
      if (seen++ > 0 && !dim && glyph.trim() !== '') return true
    }
  }
  return false
}

/** Classify a STYLED screen (rows joined by `\n`, SGR kept). */
export function readClaudeComposer(styledScreen: string): ClaudeComposer {
  const raw = styledScreen.split(/\r?\n/)
  const rows = plainRows(styledScreen)
  if (rows.every((r) => r === '')) return 'unknown'
  const box = findBox(rows)
  if (!box) return 'no-prompt'
  if (dialogOwnsKeyboard(rows, box)) return 'no-prompt'
  const promptAt = box[0] + 1
  if (!rows[promptAt].startsWith('❯')) return 'draft' // shell mode: `!` means the user is typing a command
  for (let i = promptAt + 1; i < box[1]; i++) if (rows[i].trim() !== '') return 'draft' // wrapped / multi-line input
  return hasBrightTextAfterPrompt(raw[promptAt]) ? 'draft' : 'empty'
}

/** Text after the prompt glyph on the box's prompt row, or null without a box; confirms a typed note landed. */
export function composerText(styledScreen: string): string | null {
  const rows = plainRows(styledScreen)
  const box = findBox(rows)
  return box ? rows[box[0] + 1].replace(/^[❯!]\s?/, '') : null
}
