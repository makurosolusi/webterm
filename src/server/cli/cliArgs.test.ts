import { describe, expect, it } from 'vitest'
import { levenshtein, parseArgs, suggestOption } from './cliArgs'

describe('parseArgs', () => {
  it('no args starts the server', () => {
    expect(parseArgs([])).toEqual({ kind: 'serve' })
  })

  it.each([
    [['-h'], { kind: 'help' }], [['--help'], { kind: 'help' }],
    [['-v'], { kind: 'version' }], [['--version'], { kind: 'version' }],
    [['-r'], { kind: 'readme' }], [['--readme'], { kind: 'readme' }],
    [['-d'], { kind: 'docs', topic: undefined }], [['--docs'], { kind: 'docs', topic: undefined }],
    [['--docs', 'env'], { kind: 'docs', topic: 'env' }], [['-d', 'tests'], { kind: 'docs', topic: 'tests' }],
    [['--docs=env'], { kind: 'docs', topic: 'env' }],
  ])('%j', (argv, action) => {
    expect(parseArgs(argv)).toEqual(action)
  })

  it('help wins over every other flag, version over readme/docs', () => {
    expect(parseArgs(['-h', '-v'])).toEqual({ kind: 'help' })
    expect(parseArgs(['-v', '--help', '--docs', 'env'])).toEqual({ kind: 'help' })
    expect(parseArgs(['--docs', '-v'])).toEqual({ kind: 'version' })
    expect(parseArgs(['-r', '-d'])).toEqual({ kind: 'readme' })
  })

  it('a flag after --docs is not taken as its topic', () => {
    expect(parseArgs(['--docs', '-r'])).toEqual({ kind: 'readme' })
  })

  it('unknown option is an error with a suggestion, even next to valid flags', () => {
    const r = parseArgs(['--hepl'])
    expect(r).toEqual({ kind: 'error', message: "unknown option '--hepl'\ndid you mean '--help'?" })
    expect(parseArgs(['-h', '--bogus'])).toEqual({ kind: 'error', message: "unknown option '--bogus'" })
  })

  it('stray positional is an unknown argument', () => {
    expect(parseArgs(['serve'])).toEqual({ kind: 'error', message: "unknown argument 'serve'" })
    expect(parseArgs(['version'])).toEqual({ kind: 'error', message: "unknown argument 'version'\ndid you mean '--version'?" })
  })

  it('a value on a flag that takes none is rejected', () => {
    expect(parseArgs(['--help=x'])).toEqual({ kind: 'error', message: "option '--help' takes no value" })
  })
})

describe('suggestOption', () => {
  it('suggests within distance 2, nothing beyond', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3)
    expect(suggestOption('--verison')).toBe('--version')
    expect(suggestOption('--doc')).toBe('--docs')
    expect(suggestOption('-x')).toBeUndefined()
    expect(suggestOption('--port')).toBeUndefined()
  })
})

describe('--reset-password', () => {
  it('takes a required username, as a separate arg or =value', () => {
    expect(parseArgs(['--reset-password', 'alice'])).toEqual({ kind: 'reset-password', username: 'alice' })
    expect(parseArgs(['--reset-password=alice'])).toEqual({ kind: 'reset-password', username: 'alice' })
    expect(parseArgs(['--reset-password'])).toEqual({ kind: 'error', message: "option '--reset-password' needs a value" })
    expect(parseArgs(['--reset-password='])).toEqual({ kind: 'error', message: "option '--reset-password' needs a value" })
    expect(parseArgs(['--help', '--reset-password', 'alice'])).toEqual({ kind: 'help' })
    expect(suggestOption('--reset-pasword')).toBe('--reset-password')
  })
})
