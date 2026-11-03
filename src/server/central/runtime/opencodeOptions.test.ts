import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OPENCODE_BIN, DEFAULT_OPENCODE_MODEL, OPENCODE_PERMISSION_DENY,
  buildOpencodeArgs, buildOpencodeInvocation, opencodeBin, opencodeModel,
  opencodeToolsAllowed, scrubOpencodeEnv,
} from './opencodeOptions'

describe('opencode argv', () => {
  it('builds `run --format json --model` with the prompt last', () => {
    expect(buildOpencodeArgs({ prompt: 'hello', model: 'opencode/test-model' })).toEqual([
      'run', '--format', 'json', '--model', 'opencode/test-model', 'hello',
    ])
  })

  it('omits empty session/title and never passes --auto', () => {
    const args = buildOpencodeArgs({ prompt: 'hi', model: 'm', sessionRef: '  ', title: '' })
    expect(args).not.toContain('--auto')
    expect(args).not.toContain('--session')
    expect(args).not.toContain('--title')
  })

  it('adds --session for resume and --title when provided', () => {
    expect(
      buildOpencodeArgs({ prompt: 'more', model: 'm', sessionRef: 'ses_123', title: 'Central' })
    ).toEqual([
      'run', '--format', 'json', '--model', 'm', '--session', 'ses_123', '--title', 'Central', 'more',
    ])
  })

  it('defaults model and binary but honors explicit values', () => {
    expect(opencodeModel('')).toBe(DEFAULT_OPENCODE_MODEL)
    expect(opencodeModel('  ')).toBe(DEFAULT_OPENCODE_MODEL)
    expect(opencodeModel(' custom/model ')).toBe('custom/model')
    expect(opencodeBin('')).toBe(DEFAULT_OPENCODE_BIN)
    expect(opencodeBin('/opt/opencode')).toBe('/opt/opencode')
  })

  it('only treats the exact `on` value as enabling mutating tools', () => {
    expect(opencodeToolsAllowed(undefined)).toBe(false)
    expect(opencodeToolsAllowed('1')).toBe(false)
    expect(opencodeToolsAllowed(' true ')).toBe(false)
    expect(opencodeToolsAllowed(' ON ')).toBe(true)
  })
})

describe('opencode child environment', () => {
  const baseEnv = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    USER: 'u',
    SHELL: '/bin/sh',
    LANG: 'en_US.UTF-8',
    TMPDIR: '/tmp',
    OPENAI_API_KEY: 'sk-test-value',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    WEBTERM_TOKEN: 'root-secret',
    WEBTERM_CENTRAL_RUNTIME: 'opencode',
    NODETERM_TOKEN: 'nd-secret',
    RANDOM_UNRELATED: 'drop-me',
  }

  it('keeps PATH/HOME/provider keys and drops WEBTERM_*/NODETERM_* secrets', () => {
    const env = scrubOpencodeEnv(baseEnv)
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/u')
    expect(env.OPENAI_API_KEY).toBe('sk-test-value')
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test')
    expect(env.WEBTERM_TOKEN).toBeUndefined()
    expect(env.WEBTERM_CENTRAL_RUNTIME).toBeUndefined()
    expect(env.NODETERM_TOKEN).toBeUndefined()
    expect(env.RANDOM_UNRELATED).toBeUndefined()
    expect(Object.keys(env).some((key) => key.startsWith('WEBTERM_'))).toBe(false)
  })

  it('denies mutating built-in tools through OPENCODE_PERMISSION by default', () => {
    const invocation = buildOpencodeInvocation({ prompt: 'hi', model: 'm', env: baseEnv })
    expect(invocation.env['WEBTERM_TOKEN']).toBeUndefined()
    const permission = JSON.parse(String(invocation.env['OPENCODE_PERMISSION'])) as Record<string, string>
    expect(permission).toEqual(OPENCODE_PERMISSION_DENY)
    expect(permission['bash']).toBe('deny')
    expect(permission['edit']).toBe('deny')
    expect(permission['webfetch']).toBe('deny')
    expect(permission['task']).toBe('deny')
  })

  it('replaces HOME and XDG_* with the webterm-owned home when given', () => {
    const invocation = buildOpencodeInvocation({
      prompt: 'hi', model: 'm', homeDir: '/data/central/home',
      env: { ...baseEnv, XDG_CONFIG_HOME: '/home/u/.config', XDG_DATA_HOME: '/home/u/.local/share' },
    })
    expect(invocation.env['HOME']).toBe('/data/central/home')
    expect(invocation.env['XDG_CONFIG_HOME']).toBe('/data/central/home/.config')
    expect(invocation.env['XDG_DATA_HOME']).toBe('/data/central/home/.local/share')
    expect(invocation.env['XDG_CACHE_HOME']).toBe('/data/central/home/.cache')
    expect(invocation.env['XDG_STATE_HOME']).toBe('/data/central/home/.local/state')
    expect(Object.values(invocation.env).some((value) => String(value).includes('/home/u'))).toBe(false)
  })

  it('allows tools only when explicitly opted in', () => {
    const invocation = buildOpencodeInvocation({
      prompt: 'hi', model: 'm', env: baseEnv, allowTools: true,
    })
    expect(JSON.parse(String(invocation.env['OPENCODE_PERMISSION']))).toEqual({
      bash: 'allow', edit: 'allow', webfetch: 'allow', task: 'allow',
    })
  })

  it('falls back to the server cwd and configured binary', () => {
    const invocation = buildOpencodeInvocation({ prompt: 'hi', model: 'm', env: baseEnv })
    expect(invocation.executable).toBe(DEFAULT_OPENCODE_BIN)
    expect(invocation.cwd.length).toBeGreaterThan(0)
    expect(invocation.args.at(-1)).toBe('hi')
  })
})
