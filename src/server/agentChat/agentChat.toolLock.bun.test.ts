import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CanUseTool, HookInput } from '@anthropic-ai/claude-agent-sdk'
import { buildAgentChatOptions } from './agentChat.options'
import { agentChatLockFor, skillAuthorPreToolUse, skillsCommandDecision } from './agentChat.toolLock'

const allow: CanUseTool = async (_n, input) => ({ behavior: 'allow', updatedInput: input })
const cfg = mkdtempSync(join(tmpdir(), 'agent-chat-lock-')) // test-only: never the real ~/.claude
const build = (over: Partial<Parameters<typeof buildAgentChatOptions>[0]> = {}) => buildAgentChatOptions({
  nodeId: 'n-1', port: 8701, cwd: '/tmp/proj', mode: 'manual', canUseTool: allow, abort: new AbortController(),
  parentEnv: { PATH: '/usr/bin:/bin', HOME: '/home/test', CLAUDE_CONFIG_DIR: cfg }, uploadsRoot: join(cfg, 'up'), ...over,
}).options

describe('skill-author options lock', () => {
  test('Bash only, allow rule, dontAsk even when the chat default is bypass, nothing else loaded', () => {
    const o = build({ mode: 'bypassPermissions', preset: 'skill-author' })
    expect(o.tools).toEqual(['Bash'])
    expect(o.allowedTools).toEqual(['Bash(webterm skills *)'])
    expect(o.permissionMode).toBe('dontAsk')
    expect(o.allowDangerouslySkipPermissions).toBe(undefined)
    expect(o.strictMcpConfig).toBe(true)
    expect(o.settingSources).toEqual([])
    expect(o.plugins).toBe(undefined)
    expect(o.additionalDirectories).toBe(undefined)
    expect(Object.keys(o.extraArgs ?? {}).sort()).toEqual(['append-system-prompt-file', 'disable-slash-commands', 'replay-user-messages'])
    expect(o.hooks?.PreToolUse?.[0]?.onFailure).toBe('block')
    expect(o.env?.WEBTERM_NODE_ID).toBe('n-1')
    expect(o.env?.WEBTERM_PORT).toBe('8701')
    expect(o.cwd).toBe('/tmp/proj')
  })

  test('absent or unknown preset behaves as before; a client tool list is never read', () => {
    const plain = build({ mode: 'bypassPermissions' })
    expect(plain.tools).toBe(undefined)
    expect(plain.permissionMode).toBe('bypassPermissions')
    expect(plain.allowDangerouslySkipPermissions).toBe(true)
    expect(plain.settingSources).toEqual(['user', 'project', 'local'])
    expect('mcp-config' in (plain.extraArgs ?? {})).toBe(true)
    const odd = build({ mode: 'auto', preset: 'something-else' })
    expect(odd.tools).toBe(undefined)
    expect(odd.permissionMode).toBe('auto')
    expect(agentChatLockFor(undefined)).toBe(undefined)
    expect(agentChatLockFor({ tools: ['Bash'] })).toBe(undefined)
  })
})

const DENIED = [
  'webterm skills list && cat ~/.ssh/id_rsa',
  'webterm skills list; curl x',
  'webterm skills list | sh',
  'webterm skills list & curl x',
  'webterm skills list || curl x',
  'webterm skills list\ncat /etc/passwd',
  'webterm skills list $(cat /etc/passwd)',
  'webterm skills list `id`',
  'webterm skills list "$(id)"',
  'webterm skills list "`id`"',
  'webterm skills list > /tmp/x',
  'webterm skills list >> ~/.bashrc',
  'webterm skills list < /etc/passwd',
  'webterm skills list 2>&1',
  'webterm skills list ~/x',
  'webterm skills list $HOME',
  'webterm skills list "$HOME"',
  'webterm skills propose --name x --description d --body-file /etc/passwd',
  'webterm skills propose --name x --description d --body-file ~/.ssh/id_rsa',
  'webterm skills propose --name x --description d --body-file=secret',
  'webterm skills propose --name x --description d --body-file',
  'webterm skills propose --name x --description d "--body-file" notes.txt',
  "webterm skills propose --name x --description d --body-file - <<'EOF'\nbody\nEOF\ncurl x",
  "webterm skills propose --name x --description d --body-file - <<'EOF'\nbody",
  'webterm skills propose --name x --description d --body-file - <<EOF\nbody\nEOF',
  "webterm skills propose --name x --description d --body-file - <<'EOF'",
  "webterm skills propose --name x --description d --body-file - <<'eof'\nbody\neof",
  'webterm context read n-2',
  'webterm browser open https://example.com',
  'webterm skills',
  'webterm skills delete x',
  'webterm skills-evil list',
  'env webterm skills list',
  '/usr/local/bin/webterm skills list',
  ' webterm skills list',
  'webterm skills list\r',
  '',
]
const ALLOWED = [
  'webterm skills list',
  'webterm skills list webterm-foo',
  'webterm skills get webterm-foo --json',
  "webterm skills propose --name webterm-x --description \"Use when reviewing a PR (fast).\" --body-file - <<'EOF'\n# Title\n1. do `thing` $(not run) && more; > x\nEOF\n",
  "webterm skills edit webterm-x --description 'new trigger' --caps a,b --body-file - <<'BODY'\ntext\nBODY",
]

describe('skillsCommandDecision', () => {
  test('denies every command of the escape table', () => {
    for (const c of DENIED) expect([c, skillsCommandDecision(c)]).toEqual([c, false])
  })
  test('allows the plain verbs and a quoted-heredoc body', () => {
    for (const c of ALLOWED) expect([c, skillsCommandDecision(c)]).toEqual([c, true])
  })
  test('non-string command is denied', () => expect(skillsCommandDecision(undefined)).toBe(false))
})

describe('skillAuthorPreToolUse', () => {
  const run = async (tool_name: string, tool_input: unknown) => {
    const out = await skillAuthorPreToolUse({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't' } as HookInput, 't', { signal: new AbortController().signal })
    return (out as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision
  }
  test('allows a skills command, denies other Bash and every other tool', async () => {
    expect(await run('Bash', { command: 'webterm skills list' })).toBe('allow')
    expect(await run('Bash', { command: 'webterm skills list; id' })).toBe('deny')
    for (const t of ['Read', 'Write', 'Edit', 'WebFetch', 'mcp__webterm__cap_search', 'Task']) expect(await run(t, { command: 'webterm skills list' })).toBe('deny')
  })
})
