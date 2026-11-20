import { afterEach, describe, expect, it } from 'vitest'
import { setProxyEndpointSource } from '../../credentialProxy/credentialProxy.env'
import { logBus } from '../../logs'
import { CENTRAL_STEWARD_PROMPT, centralQueryOptions, claudeChildEnv, claudeModelArg } from './claudeOptions'

const PROXY = { url: 'http://127.0.0.1:41999', token: 'wtp_placeholder-test-only' } // test-only
afterEach(() => setProxyEndpointSource(() => null))

describe('claudeChildEnv', () => {
  it('fails closed when a credential is present and no proxy runs', () => {
    expect(() => claudeChildEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'k' })).toThrow('credential_proxy_unavailable') // test-only
  })

  it('keeps only allowlisted variables and named provider vars; drops root tokens, other provider keys and capability tokens', () => {
    setProxyEndpointSource(() => PROXY)
    const env = claudeChildEnv({
      PATH: '/usr/bin', HOME: '/home/u', LANG: 'en_US.UTF-8', LC_ALL: 'C', https_proxy: 'http://p:1',
      CLAUDE_CONFIG_DIR: '/cfg', SSL_CERT_FILE: '/ca.pem',
      WEBTERM_TOKEN: 'root', NODETERM_NODE_ID: 'n1', ANTHROPIC_API_KEY: 'k', ANTHROPIC_UNLISTED: 'x', OPENAI_API_KEY: 'k',
      CLAUDE_CODE_OAUTH_TOKEN: 't', SECRET_THING: 'x', WCAP_HOLDER: 'wcap_abc123', SHELL: '/bin/zsh',
    })
    expect(Object.keys(env).sort()).toEqual(
      ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'SSL_CERT_FILE', 'https_proxy']
    )
    expect([env.ANTHROPIC_API_KEY, env.ANTHROPIC_BASE_URL]).toEqual([PROXY.token, PROXY.url]) // the real 'k' never arrives
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
    // Ownership of delegations (open duties), with no per-turn data so the prefix stays cache-stable.
    expect(CENTRAL_STEWARD_PROMPT).toContain('You own every delegation you start. When one is listed under Open duties, act on it this turn')
    expect(CENTRAL_STEWARD_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  // One page or one search is Central's own job (browser_read); chains go to the playbook; no parallel workers for one task.
  it('sends one page to browser_read and chained research to the playbook, and forbids duplicate workers', () => {
    expect(CENTRAL_STEWARD_PROMPT).toContain('How: browser_read {"url"')
    expect(CENTRAL_STEWARD_PROMPT).toContain('use playbook.web_research')
    expect(CENTRAL_STEWARD_PROMPT).toContain('never start parallel workers for the same task')
  })

  // Policy lock (root cause: Central proposed "shall I type /model?" even in Danger mode, where no card is shown).
  it('tells Central to act instead of proposing, and how to switch an agent model', () => {
    expect(CENTRAL_STEWARD_PROMPT).toContain('Act, do not propose')
    expect(CENTRAL_STEWARD_PROMPT).toContain('Never end with "shall I...?"')
    expect(CENTRAL_STEWARD_PROMPT).toContain('If the mode needs approval, just call the tool; webterm shows the card.')
    expect(CENTRAL_STEWARD_PROMPT).toContain('approval mode (ask, auto, danger)')
    expect(CENTRAL_STEWARD_PROMPT).toMatch(/chat\.config for an Agent Chat node; for a Claude terminal node, canvas\.type the text "\/model <alias>" then press Enter/)
  })

  // Root-cause lock: Central typed /model into a research worker on its own and overrode the complexity ladder.
  it('changes a worker model only when the user asks; otherwise the system picks it from complexity', () => {
    const p = CENTRAL_STEWARD_PROMPT
    expect(p).toContain('Change an agent\'s model only when the user asks for it')
    expect(p).toMatch(/picks the worker model from complexity/)
    expect(p).toContain('never request Fable')
    // every "/model" instruction must sit inside the conditional sentence (no unconditional typing)
    expect(p).not.toMatch(/(^|\. )(To switch|Type|Always type)[^.]*\/model/)
    expect(p.indexOf('/model <alias>')).toBeGreaterThan(p.indexOf('only when the user asks'))
    expect(p.indexOf('only when the user asks')).toBeLessThan(p.indexOf('/model <alias>'))
  })

  // Policy lock (root cause: "Use reminder.set for anything you should check later" made Central poll its own delegations).
  it('says delegated work reports by itself and keeps reminders for what only time can tell', () => {
    expect(CENTRAL_STEWARD_PROMPT).not.toContain('Use reminder.set for anything you should check later')
    expect(CENTRAL_STEWARD_PROMPT).toContain('webterm wakes you with a check-in at once, so never set a reminder or poll to look at delegated work')
    expect(CENTRAL_STEWARD_PROMPT).toContain('Use reminder.set only for what time alone can tell')
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
