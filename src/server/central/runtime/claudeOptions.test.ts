import { describe, expect, it } from 'vitest'
import { CENTRAL_STEWARD_PROMPT, claudeArgv, claudeChildEnv, claudeModelArg } from './claudeOptions'

describe('claudeChildEnv', () => {
  it('keeps only allowlisted variables and drops root tokens, provider keys and capability tokens', () => {
    const env = claudeChildEnv({
      PATH: '/usr/bin', HOME: '/home/u', LANG: 'en_US.UTF-8', LC_ALL: 'C', https_proxy: 'http://p:1',
      CLAUDE_CONFIG_DIR: '/cfg', SSL_CERT_FILE: '/ca.pem',
      WEBTERM_TOKEN: 'root', NODETERM_NODE_ID: 'n1', ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k',
      CLAUDE_CODE_OAUTH_TOKEN: 't', SECRET_THING: 'x', WCAP_HOLDER: 'wcap_abc123', SHELL: '/bin/zsh',
    })
    expect(Object.keys(env).sort()).toEqual(
      ['CLAUDE_CONFIG_DIR', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'SSL_CERT_FILE', 'https_proxy']
    )
  })

  it('drops an allowlisted name whose value is a capability token', () => {
    expect(claudeChildEnv({ PATH: '/bin', HOME: 'wcap_leaked' })).toEqual({ PATH: '/bin' })
  })
})

describe('claudeArgv', () => {
  const base = { newSessionId: 'uuid-1', maxTurns: 3, mcpConfig: '/run/t.mcp.json' }

  it('builds the fixed locked-down argv for a first turn: no built-ins, webterm MCP only', () => {
    expect(claudeArgv(base)).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--tools', '', '--mcp-config', '/run/t.mcp.json', '--strict-mcp-config', '--allowedTools', 'mcp__webterm__*',
      '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
      '--setting-sources', '', '--disable-slash-commands',
      '--append-system-prompt', CENTRAL_STEWARD_PROMPT,
      '--max-turns', '3', '--session-id', 'uuid-1',
    ])
    expect(CENTRAL_STEWARD_PROMPT).toContain('approval_required')
    expect(CENTRAL_STEWARD_PROMPT).not.toContain('webterm-proposal')
  })

  it('never uses --safe-mode, which would drop the --mcp-config server', () => {
    expect(claudeArgv(base)).not.toContain('--safe-mode')
  })

  it('resumes instead of creating a session when a sessionRef exists, and adds model and budget', () => {
    const argv = claudeArgv({ ...base, sessionRef: ' sess-9 ', model: 'sonnet', maxBudgetUsd: 0.5 })
    expect(argv.slice(-2)).toEqual(['--resume', 'sess-9'])
    expect(argv).not.toContain('--session-id')
    expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet')
    expect(argv[argv.indexOf('--max-budget-usd') + 1]).toBe('0.5')
  })

  it('never contains a permission bypass or an unrequested mode', () => {
    const joined = claudeArgv({ ...base, model: 'opus' }).join(' ')
    for (const banned of ['bypassPermissions', '--dangerously-skip-permissions', '--bare',
      '--no-session-persistence', '--fork-session', '--permission-prompt-tool', '--add-dir']) {
      expect(joined).not.toContain(banned)
    }
  })
})

describe('claudeModelArg', () => {
  it('passes aliases and claude-* ids, treats blank as the CLI default', () => {
    expect(claudeModelArg('sonnet')).toEqual({ arg: 'sonnet', ignored: false })
    expect(claudeModelArg(' claude-opus-x.y ')).toEqual({ arg: 'claude-opus-x.y', ignored: false })
    expect(claudeModelArg('')).toEqual({ ignored: false })
    expect(claudeModelArg(undefined)).toEqual({ ignored: false })
  })

  it('does not forward provider/model or unknown ids', () => {
    expect(claudeModelArg('opencode/deepseek-v4.1-flash-free')).toEqual({ ignored: true })
    expect(claudeModelArg('gpt-x')).toEqual({ ignored: true })
  })
})
