import { describe, expect, it } from 'vitest'
import { logBus } from '../../logs'
import { CENTRAL_STEWARD_PROMPT, centralQueryOptions, claudeChildEnv, claudeModelArg } from './claudeOptions'

describe('claudeChildEnv', () => {
  it('keeps only allowlisted variables and named provider vars; drops root tokens, other provider keys and capability tokens', () => {
    const env = claudeChildEnv({
      PATH: '/usr/bin', HOME: '/home/u', LANG: 'en_US.UTF-8', LC_ALL: 'C', https_proxy: 'http://p:1',
      CLAUDE_CONFIG_DIR: '/cfg', SSL_CERT_FILE: '/ca.pem',
      WEBTERM_TOKEN: 'root', NODETERM_NODE_ID: 'n1', ANTHROPIC_API_KEY: 'k', ANTHROPIC_UNLISTED: 'x', OPENAI_API_KEY: 'k',
      CLAUDE_CODE_OAUTH_TOKEN: 't', SECRET_THING: 'x', WCAP_HOLDER: 'wcap_abc123', SHELL: '/bin/zsh',
    })
    expect(Object.keys(env).sort()).toEqual(
      ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB', 'CLAUDE_CONFIG_DIR', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'SSL_CERT_FILE', 'https_proxy']
    )
  })

  it('drops an allowlisted name whose value is a capability token', () => {
    expect(claudeChildEnv({ PATH: '/bin', HOME: 'wcap_leaked' })).toEqual({ PATH: '/bin' })
  })
})

describe('centralQueryOptions', () => {
  const abort = new AbortController()
  const base = { newSessionId: 'uuid-1', maxTurns: 3, mcpConfig: '/run/t.mcp.json', cwd: '/work', env: { PATH: '/bin' }, abort }

  it('builds the locked-down SDK options for a first turn: no built-ins, webterm MCP only, deny-by-default', () => {
    expect(centralQueryOptions(base)).toEqual({
      tools: [],
      extraArgs: { 'mcp-config': '/run/t.mcp.json', 'disable-slash-commands': null },
      strictMcpConfig: true,
      allowedTools: ['mcp__webterm__*'],
      permissionMode: 'dontAsk',
      permissionPrompts: 'none',
      settingSources: [],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: CENTRAL_STEWARD_PROMPT },
      includePartialMessages: true,
      maxTurns: 3,
      sessionId: 'uuid-1',
      cwd: '/work',
      env: { PATH: '/bin' },
      abortController: abort,
    })
    expect(CENTRAL_STEWARD_PROMPT).toContain('approval_required')
  })

  it('resumes instead of creating a session when a sessionRef exists, and adds model and budget', () => {
    const o = centralQueryOptions({ ...base, sessionRef: ' sess-9 ', model: 'sonnet', maxBudgetUsd: 0.5 })
    expect(o.resume).toBe('sess-9')
    expect(o.sessionId).toBeUndefined()
    expect(o.model).toBe('sonnet')
    expect(o.maxBudgetUsd).toBe(0.5)
  })

  it('passes effort through only when set (absent = CLI default)', () => {
    expect('effort' in centralQueryOptions(base)).toBe(false)
    expect(centralQueryOptions({ ...base, effort: 'xhigh' }).effort).toBe('xhigh')
  })

  it('never sets a permission bypass, a permission callback or extra MCP servers', () => {
    const o = centralQueryOptions({ ...base, model: 'opus' })
    expect(o.permissionMode).not.toBe('bypassPermissions')
    for (const banned of ['allowDangerouslySkipPermissions', 'canUseTool', 'permissionPromptToolName', 'mcpServers', 'plugins', 'hooks', 'additionalDirectories', 'forkSession']) {
      expect(banned in o).toBe(false)
    }
    expect(JSON.stringify(o)).not.toMatch(/bypassPermissions|dangerously|safe-mode/)
  })
})

describe('claudeModelArg', () => {
  it('passes aliases and claude-* ids, treats blank as the CLI default', () => {
    expect(claudeModelArg('sonnet')).toEqual({ arg: 'sonnet', ignored: false })
    expect(claudeModelArg('fable')).toEqual({ arg: 'fable', ignored: false })
    expect(claudeModelArg('claude-fable-5-1')).toEqual({ arg: 'claude-fable-5-1', ignored: false })
    expect(claudeModelArg(' claude-opus-x.y ')).toEqual({ arg: 'claude-opus-x.y', ignored: false })
    expect(claudeModelArg('')).toEqual({ ignored: false })
    expect(claudeModelArg(undefined)).toEqual({ ignored: false })
  })

  it('passes proxy model names; refuses shell metacharacters, whitespace and leftover opencode/ models with one warning naming the variable', () => {
    expect(claudeModelArg('my-proxy/glm-4.6')).toEqual({ arg: 'my-proxy/glm-4.6', ignored: false })
    expect(claudeModelArg('z-ai/glm-4.6')).toEqual({ arg: 'z-ai/glm-4.6', ignored: false })
    expect(claudeModelArg('gpt-x')).toEqual({ arg: 'gpt-x', ignored: false })
    expect(claudeModelArg('us.anthropic.claude-x:0@v[1m]')).toEqual({ arg: 'us.anthropic.claude-x:0@v[1m]', ignored: false })
    const before = logBus.query().filter((e) => e.event === 'central.claude_model_ignored').length
    expect(claudeModelArg('a; rm')).toEqual({ ignored: true })
    expect(claudeModelArg('$(x)')).toEqual({ ignored: true })
    expect(claudeModelArg('two words')).toEqual({ ignored: true })
    expect(claudeModelArg('opencode/deepseek-v4.1-flash-free')).toEqual({ ignored: true })
    const warns = logBus.query().filter((e) => e.event === 'central.claude_model_ignored')
    expect(warns.length - before).toBe(1)
    expect(warns.at(-1)?.message).toContain('WEBTERM_CENTRAL_MODEL')
  })
})
