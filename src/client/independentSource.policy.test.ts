import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// These files were rewritten from documented behaviour (xterm.js options, the Claude Code docs, the
// WAI-ARIA tree pattern, openly licensed palettes). A marker that says "ported from" or "copied
// from" would contradict that and invite drift back to a copy, so none may reappear.
const FILES = [
  'themes.ts',
  'terminalConfig.ts',
  'agentActions.ts',
  'filesKeys.ts',
  'editorFile.ts',
  'markdownLinks.ts',
  'themes.test.ts',
  'terminalConfig.test.ts',
  'agentActions.test.ts',
  'filesKeys.test.ts',
  'editorFile.test.ts',
  'markdownLinks.test.ts',
  'chrome-kit.test.ts',
]

/** `\bported\b` does not match "reported"; "port" alone is not listed because it also means a network port. */
const MARKER = /\bported\b|\bporting\b|\bport dari\b|\bcopied from\b|\bdiport(ing)?\b|^\s*(\/\/|\/?\*+)\s*port\b/im

describe('independently written client files', () => {
  it.each(FILES)('%s carries no port/copied-from marker', (file) => {
    const text = readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), 'utf8')
    expect(text).not.toMatch(MARKER)
  })

  it('the marker pattern catches the phrases it exists for', () => {
    for (const phrase of ['// Ported from X', '// Diport dari X', 'Diporting logic', 'copied from upstream', '/** Port of the table */']) {
      expect(phrase, phrase).toMatch(MARKER)
    }
    expect('a port number and reported status').not.toMatch(MARKER)
  })
})
