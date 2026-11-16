import { describe, expect, it } from 'vitest'
import { normalizeClaudeCommand, splitLaunch } from './claudeLaunch.normalize'
import { hasUnclosedQuote, shellSplit } from './shellQuote'

const n = normalizeClaudeCommand

describe('normalizeClaudeCommand', () => {
  it('empty or blank means Default (bare claude), no warnings', () => {
    for (const s of ['', '   ']) expect(n(s)).toEqual({ argv: ['claude'], warnings: [] })
  })

  it('full form and prefix form normalise to the same argv', () => {
    const full = n('envman -e claude:malik-opus -- claude')
    expect(full).toEqual({ argv: ['envman', '-e', 'claude:malik-opus', '--', 'claude'], warnings: [] })
    expect(n('envman -e claude:malik-opus --')).toEqual(full)
    expect(n('envman -e claude:malik-opus -- ')).toEqual(full)
  })

  it('detects a doubled claude and suggests the fix', () => {
    const r = n('envman -e x -- claude claude --model opus')
    expect(r.argv).toEqual(['envman', '-e', 'x', '--', 'claude', '--model', 'opus'])
    expect(r.warnings).toContain('Removed a repeated "claude".')
    expect(r.suggestion).toBe('envman -e x -- claude --model opus')
    expect(n('claude claude').argv).toEqual(['claude'])
  })

  it('detects a missing -- for envman, op run and doppler run', () => {
    const e = n('envman -e x claude')
    expect(e.argv).toEqual(['envman', '-e', 'x', '--', 'claude'])
    expect(e.warnings).toEqual(['envman needs "--" before the command it runs.'])
    expect(e.suggestion).toBe('envman -e x -- claude')
    expect(n('envman -e x').suggestion).toBe('envman -e x -- claude')
    expect(n('op run --env-file .env claude').suggestion).toBe('op run --env-file .env -- claude')
    expect(n('doppler run claude --model x').suggestion).toBe('doppler run -- claude --model x')
  })

  it('env and direnv exec take the command positionally (no -- needed)', () => {
    expect(n('env FOO=1 -u BAR claude')).toEqual({ argv: ['env', 'FOO=1', '-u', 'BAR', 'claude'], warnings: [] })
    expect(n('env FOO=1').argv).toEqual(['env', 'FOO=1', 'claude'])
    expect(n('direnv exec /proj').argv).toEqual(['direnv', 'exec', '/proj', 'claude'])
    expect(n('direnv exec /proj claude --model x').warnings).toEqual([])
  })

  it('keeps extra claude flags, and adds claude when only its flags follow --', () => {
    expect(n('envman -e x -- claude --model opus --verbose').argv.slice(4)).toEqual(['claude', '--model', 'opus', '--verbose'])
    const r = n('envman -e x -- --model opus')
    expect(r.argv).toEqual(['envman', '-e', 'x', '--', 'claude', '--model', 'opus'])
    expect(r.warnings).toEqual(['Added "claude" before its flags.'])
    expect(n('claude --model opus')).toEqual({ argv: ['claude', '--model', 'opus'], warnings: [] })
  })

  it('an unknown wrapper launches the same way: no known-name list gates it', () => {
    for (const w of [['infisical', 'run'], ['aws-vault', 'exec', 'prod'], ['my-secret-tool', '--vault', 'x']]) {
      const full = n([...w, '--', 'claude', '--model', 'opus'].join(' '))
      expect(full).toEqual({ argv: [...w, '--', 'claude', '--model', 'opus'], warnings: [] })
      expect(n([...w, '--'].join(' ')).argv).toEqual([...w, '--', 'claude']) // prefix form adds claude
      expect(splitLaunch(full.argv)).toEqual({ wrapper: [...w, '--'], bin: 'claude', flags: ['--model', 'opus'] })
    }
  })

  it('a custom launcher script is the command itself', () => {
    expect(n('/opt/bin/claude-work --account b')).toEqual({ argv: ['/opt/bin/claude-work', '--account', 'b'], warnings: [] })
  })

  it('strips a pasted prompt and warns about shell syntax, ~ and literal secrets', () => {
    const p = n('$ envman -e x -- claude')
    expect(p.argv[0]).toBe('envman')
    expect(p.suggestion).toBe('envman -e x -- claude')
    expect(n('claude && echo hi').warnings[0]).toMatch(/Shell syntax/)
    expect(n('~/bin/envman -e x -- claude').warnings).toContain('"~" is not expanded here. Use the full path.')
    expect(n('env ANTHROPIC_API_KEY=sk-test-only claude').warnings.join(' ')).toMatch(/secret/)
  })

  it('quoted arguments stay one token', () => {
    expect(n(`envman -e 'my proj:dev' -- claude --append-system-prompt "be brief"`).argv)
      .toEqual(['envman', '-e', 'my proj:dev', '--', 'claude', '--append-system-prompt', 'be brief'])
  })
})

describe('splitLaunch', () => {
  it('splits wrapper / claude / flags', () => {
    expect(splitLaunch(n('envman -e x -- claude --model o').argv)).toEqual({ wrapper: ['envman', '-e', 'x', '--'], bin: 'claude', flags: ['--model', 'o'] })
    expect(splitLaunch(['claude'])).toEqual({ wrapper: [], bin: 'claude', flags: [] })
  })
})

describe('shellSplit ', () => {
  it('quotes, escapes, no expansion', () => {
    expect(shellSplit("--msg 'hello world'")).toEqual(['--msg', 'hello world'])
    expect(shellSplit('a\\ b "c d"')).toEqual(['a b', 'c d'])
    expect(shellSplit('$HOME/x')).toEqual(['$HOME/x'])
  })
})

describe('hasUnclosedQuote', () => {
  it('flags an open single or double quote, not a closed or escaped one', () => {
    expect(hasUnclosedQuote("claude --model 'opus")).toBe(true)
    expect(hasUnclosedQuote('claude --model "opus')).toBe(true)
    expect(hasUnclosedQuote("claude --model 'opus 4'")).toBe(false)
    expect(hasUnclosedQuote("claude --msg it\\'s")).toBe(false)
  })
})
