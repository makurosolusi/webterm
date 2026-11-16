// Hand-built screens: pin the fail-closed rules independent of the captured fixture.
import { describe, expect, it } from 'vitest'
import { composerText, readClaudeComposer } from './linkNoteComposer'

const RULE = '─'.repeat(40)
const box = (prompt: string, ...status: string[]): string => [RULE, prompt, RULE, ...status].join('\n')

describe('readClaudeComposer on hand-built screens', () => {
  it('a dim placeholder is empty, bright text after the glyph is a draft', () => {
    expect(readClaudeComposer(box('❯ \x1b[2mTry something\x1b[0m', ' status'))).toBe('empty')
    expect(readClaudeComposer(box('❯ hi', ' status'))).toBe('draft')
    expect(readClaudeComposer(box('❯ \x1b[2mdim\x1b[22m typed'))).toBe('draft')
    expect(readClaudeComposer(box('❯ \x1b[38;5;2m\x1b[2mdim after colour\x1b[0m'))).toBe('empty')
  })

  it('shell mode and a second input row are drafts; a dialog footer or no box is no-prompt', () => {
    expect(readClaudeComposer(box('! ls'))).toBe('draft')
    expect(readClaudeComposer([RULE, '❯ ', '  continued', RULE].join('\n'))).toBe('draft')
    expect(readClaudeComposer(`${box('❯ ')}\n Esc to cancel`)).toBe('no-prompt')
    expect(readClaudeComposer('just a shell prompt $')).toBe('no-prompt')
    expect(readClaudeComposer('')).toBe('unknown')
  })

  it('the busy spinner hint ("esc to interrupt") is not a dialog footer', () => {
    expect(readClaudeComposer(box('❯ ', ' esc to interrupt'))).toBe('empty')
  })

  it('composerText strips the glyph and returns null without a box', () => {
    expect(composerText(box('❯ [webterm] hi'))).toBe('[webterm] hi')
    expect(composerText('no box here')).toBeNull()
  })
})
