import { describe, expect, it } from 'vitest'
import {
  CUSTOM_COMMAND_ARGV_MAX, CUSTOM_COMMAND_ARG_MAX_CHARS, renderShim, shQuoteWord, validateCustomCommandArgv, validateCustomCommandName,
} from './customCommands'

describe('validateCustomCommandName', () => {
  it('accepts ordinary names', () => {
    for (const n of ['envman', 'claude-env', 'a', 'x.y_z-1', '1password']) expect(validateCustomCommandName(n).ok).toBe(true)
  })
  it('rejects bad shapes', () => {
    for (const n of ['', 'Env', '-x', '.x', 'a/b', '../x', 'a b', 'x'.repeat(65), 'é', 'a;b', 42, null]) {
      expect(validateCustomCommandName(n)).toMatchObject({ ok: false, code: 'invalid_name' })
    }
  })
  it('refuses core names even with force', () => {
    for (const n of ['sh', 'git', 'ssh', 'tmux', 'bun', 'webterm']) {
      expect(validateCustomCommandName(n, true)).toMatchObject({ ok: false, code: 'reserved_name' })
    }
  })
  it('allows claude only with force', () => {
    expect(validateCustomCommandName('claude')).toMatchObject({ ok: false, code: 'reserved_name' })
    expect(validateCustomCommandName('claude', true).ok).toBe(true)
  })
})

describe('validateCustomCommandArgv', () => {
  it('enforces count, length, NUL and empty program', () => {
    expect(validateCustomCommandArgv(['envman', 'run']).ok).toBe(true)
    expect(validateCustomCommandArgv([]).ok).toBe(false)
    expect(validateCustomCommandArgv('envman').ok).toBe(false)
    expect(validateCustomCommandArgv(Array(CUSTOM_COMMAND_ARGV_MAX + 1).fill('a')).ok).toBe(false)
    expect(validateCustomCommandArgv(Array(CUSTOM_COMMAND_ARGV_MAX).fill('a')).ok).toBe(true)
    expect(validateCustomCommandArgv(['a'.repeat(CUSTOM_COMMAND_ARG_MAX_CHARS + 1)]).ok).toBe(false)
    expect(validateCustomCommandArgv(['a'.repeat(CUSTOM_COMMAND_ARG_MAX_CHARS)]).ok).toBe(true)
    expect(validateCustomCommandArgv(['a\0b']).ok).toBe(false)
    expect(validateCustomCommandArgv(['', 'x']).ok).toBe(false)
    expect(validateCustomCommandArgv([1, 'x']).ok).toBe(false)
  })
})

describe('renderShim', () => {
  it('quotes every word and appends "$@"', () => {
    expect(renderShim('claude-env', ['envman', 'run', '--', 'claude'], '/b')).toBe(
      "#!/bin/sh\n# webterm custom command \"claude-env\" (managed by webterm; edits are overwritten)\nexec 'envman' 'run' '--' 'claude' \"$@\"\n",
    )
  })
  it('keeps hostile words inside single quotes', () => {
    expect(shQuoteWord("a; rm -rf /")).toBe("'a; rm -rf /'")
    expect(shQuoteWord("it's")).toBe("'it'\\''s'")
    const out = renderShim('x', ['p', '$(id)', '`id`', 'a\nb', 'ünï ✓'], '/b')
    expect(out).toContain("'$(id)' '`id`' 'a\nb' 'ünï ✓'")
    expect(out.split('\n').filter((l) => l.startsWith('exec ')).length).toBe(1)
  })
  it('drops the managed dir from PATH only when the shim would call itself', () => {
    expect(renderShim('claude', ['envman', 'run', '--', 'claude'], "/d'ir")).toContain("d='/d'\\''ir'")
    expect(renderShim('claude-env', ['envman', 'claude'], '/d')).not.toContain('PATH=')
  })
})
