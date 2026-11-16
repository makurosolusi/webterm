import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { hasUnclosedQuote, joinArgv, shellQuoteIfNeeded, shellSingleQuote, shellSplit } from './shellQuote'

const awkward = [
  '',
  ' ',
  'two words',
  "it's",
  "'",
  "''",
  '$HOME',
  '`id`',
  '$(id)',
  'a"b',
  'back\\slash',
  'line1\nline2',
  'tab\there',
  'café 日本語 🙂',
  '*.ts',
  'a;b&&c|d',
  '-n',
]

describe('shellSingleQuote', () => {
  it.each([
    ['plain', "'plain'"],
    ['', "''"],
    ["it's", "'it'\\''s'"],
    ["'", "''\\'''"],
    ['$HOME `x`', "'$HOME `x`'"],
  ])('quotes %j as %s', (input, expected) => {
    expect(shellSingleQuote(input)).toBe(expected)
  })

  it('round-trips through a real sh as exactly one literal argument', () => {
    for (const text of awkward) {
      const out = execFileSync('sh', ['-c', `printf %s ${shellSingleQuote(text)}`], { encoding: 'utf8' })
      expect(out).toBe(text)
    }
  })
})

describe('shellQuoteIfNeeded', () => {
  it('leaves safe words bare', () => {
    for (const w of ['claude', '--model=opus', 'a/b/c.ts', 'x@y:1,2', '100%']) expect(shellQuoteIfNeeded(w)).toBe(w)
  })
  it('quotes the empty string and anything with a shell-significant character', () => {
    for (const w of awkward.filter((x) => x !== '-n')) expect(shellQuoteIfNeeded(w)).toBe(shellSingleQuote(w))
  })
})

describe('joinArgv', () => {
  it('keeps every element one argument when read back by sh', () => {
    const line = joinArgv(['printf', '[%s]', ...awkward])
    const out = execFileSync('sh', ['-c', line], { encoding: 'utf8' })
    // printf reuses its format once per remaining argument
    expect(out).toBe(awkward.map((a) => `[${a}]`).join(''))
  })
  it('is empty for an empty argv', () => {
    expect(joinArgv([])).toBe('')
  })
})

describe('shellSplit', () => {
  it.each([
    ['', []],
    ['   \t ', []],
    ['a b  c', ['a', 'b', 'c']],
    ["--msg 'hello world'", ['--msg', 'hello world']],
    ['a\\ b "c d"', ['a b', 'c d']],
    ["''", ['']],
    ['"" x', ['', 'x']],
    ['pre"mid dle"post', ['premid dlepost']],
    ["'a\\b'", ['a\\b']],
    ['"a\\"b"', ['a"b']],
    ['$HOME/x `y`', ['$HOME/x', '`y`']],
    ['a\nb', ['a', 'b']],
    ['héllo 日本', ['héllo', '日本']],
    ['trailing\\', ['trailing\\']],
  ])('splits %j', (input, expected) => {
    expect(shellSplit(input)).toEqual(expected)
  })

  it('undoes joinArgv for any argv', () => {
    expect(shellSplit(joinArgv(awkward))).toEqual(awkward)
  })
})

describe('hasUnclosedQuote', () => {
  it.each([
    ["claude --model 'opus", true],
    ['claude --model "opus', true],
    ["claude --model 'opus 4'", false],
    ["claude --msg it\\'s", false],
    ['"it\'s"', false],
    ['', false],
  ])('%j -> %s', (input, expected) => {
    expect(hasUnclosedQuote(input)).toBe(expected)
  })
})
