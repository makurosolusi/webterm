// The empty-input proof, end to end on REAL Claude Code screens (nodeterm fixture, Claude Code
// 2.1.301): the capture is replayed as PTY output through `renderStyledScreen` (the server-side
// xterm), then read by the ported `readClaudeComposer`.
import { describe, expect, it } from 'vitest'
import capture from './__fixtures__/claude-composer-capture.json'
import { composerText, readClaudeComposer } from './linkNoteComposer'
import { renderStyledScreen } from './linkNoteScreen'

const S = capture.screens as Record<string, string>
const COLS = 120

/** A capture as the PTY would have emitted it: CRLF line ends, one row per line. */
async function screen(name: string, mutate: (s: string) => string = (s) => s): Promise<string> {
  const raw = mutate(S[name]).replace(/\n$/, '')
  const rows = raw.split('\n').length
  return renderStyledScreen(raw.replace(/\n/g, '\r\n'), COLS, rows)
}

describe('readClaudeComposer on a server-rendered screen', () => {
  it('the dim placeholder is an EMPTY composer', async () => {
    expect(readClaudeComposer(await screen('empty'))).toBe('empty')
  })

  it('a typed draft, a multi-line draft, a paste and shell mode are all drafts', async () => {
    for (const n of ['draft', 'multiline', 'pasted', 'shellmode']) expect(readClaudeComposer(await screen(n)), n).toBe('draft')
  })

  it('the placeholder words TYPED by the user (not dim) are a draft', async () => {
    const typed = await screen('empty', (s) => s.replace('\x1b[2mTry "fix typecheck errors"\x1b[0m', 'Try "fix typecheck errors"'))
    expect(readClaudeComposer(typed)).toBe('draft')
  })

  it('a dialog footer owning the keyboard is no-prompt; an empty screen is unknown', async () => {
    const dialog = await screen('empty', (s) => s.replace(/\n[^\n]*manual mode on[^\n]*/, '\n Enter to confirm · Esc to cancel'))
    expect(readClaudeComposer(dialog)).toBe('no-prompt')
    expect(readClaudeComposer(await renderStyledScreen('', 80, 24))).toBe('unknown')
  })

  it('composerText reads what sits after the prompt', async () => {
    const typed = await screen('empty', (s) => s.replace('\x1b[2mTry "fix typecheck errors"\x1b[0m', '[webterm] hello'))
    expect(composerText(typed)).toBe('[webterm] hello')
    expect(composerText('plain shell $')).toBeNull()
  })
})
