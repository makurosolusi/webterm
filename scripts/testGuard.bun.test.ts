import { describe, expect, test } from 'bun:test'
import { bunTestArgs, decideBun, decideVitest, FULL_TESTS_ENV, MAX_FILTERS } from './testGuard.decide'

const OPEN = { [FULL_TESTS_ENV]: '1' }
const allowed = (d: { allow: boolean }): boolean => d.allow

describe('decideVitest', () => {
  test('refuses an unfiltered run in every spelling', () => {
    for (const argv of [[], ['run'], ['--run'], ['run', '--maxWorkers=2'], ['run', '--maxWorkers', '2'], ['--reporter', 'dot'], ['run', '--coverage']]) {
      expect(allowed(decideVitest(argv, {}))).toBe(false)
    }
  })
  test('the refusal carries the explicit-command message', () => {
    const d = decideVitest(['run'], {})
    expect(d.allow || d.reason).toContain('Use `npm run test:impacted`')
  })
  test('allows file filters, related, --changed and -t', () => {
    for (const argv of [['run', 'src/a.test.ts'], ['src/a.test.ts'], ['related', '--run', 'src/a.ts'], ['run', '--maxWorkers', '2', 'src/a.test.ts'], ['--changed', '--run'], ['run', '--changed=HEAD~1'], ['run', '-t', 'name'], ['--testNamePattern=x']]) {
      expect(allowed(decideVitest(argv, {}))).toBe(true)
    }
  })
  test('`related` with no files is a full run; a flag value is not a file', () => {
    expect(allowed(decideVitest(['related', '--run'], {}))).toBe(false)
    expect(allowed(decideVitest(['run', '--reporter', 'dot'], {}))).toBe(false)
  })
  test('a giant file list is a full suite in disguise', () => {
    const files = Array.from({ length: MAX_FILTERS + 1 }, (_, i) => `src/f${i}.test.ts`)
    expect(allowed(decideVitest(['run', ...files], {}))).toBe(false)
    expect(allowed(decideVitest(['run', ...files.slice(1)], {}))).toBe(true)
  })
  test('WEBTERM_FULL_TESTS=1 opens everything; other values do not', () => {
    expect(allowed(decideVitest(['run'], OPEN))).toBe(true)
    expect(allowed(decideVitest(['run', ...Array.from({ length: 200 }, (_, i) => `f${i}`)], OPEN))).toBe(true)
    expect(allowed(decideVitest(['run'], { [FULL_TESTS_ENV]: '0' }))).toBe(false)
    expect(allowed(decideVitest(['run'], { [FULL_TESTS_ENV]: 'true' }))).toBe(false)
  })
})

describe('decideBun', () => {
  test('refuses no path, and flags without a path', () => {
    for (const argv of [[], ['--no-env-file'], ['-t', 'name'], ['--timeout', '5000']]) expect(allowed(decideBun(argv, {}))).toBe(false)
  })
  test('allows explicit paths', () => {
    for (const argv of [['a.bun.test.ts'], ['--no-env-file', 'a.bun.test.ts', 'b.bun.test.ts'], ['--timeout', '5000', 'a.bun.test.ts'], ['a.bun.test.ts', '-t', 'name']]) expect(allowed(decideBun(argv, {}))).toBe(true)
  })
  test('refuses more than the limit, unless the env opens it', () => {
    const files = Array.from({ length: MAX_FILTERS + 1 }, (_, i) => `src/f${i}.bun.test.ts`)
    expect(allowed(decideBun(files, {}))).toBe(false)
    expect(allowed(decideBun(files, OPEN))).toBe(true)
    expect(allowed(decideBun([], OPEN))).toBe(true)
  })
  test('bunTestArgs reads the arguments after `test`, and ignores other commands', () => {
    expect(bunTestArgs(['/x/bun', 'test', '--no-env-file', 'a.ts'])).toEqual(['--no-env-file', 'a.ts'])
    expect(bunTestArgs(['bun', 'run', 'server.ts'])).toBeNull()
  })
})
