import { describe, expect, test } from 'bun:test'
import type { HookInput } from '@anthropic-ai/claude-agent-sdk'
import { agentChatLockFor, skillAuthorPreToolUse } from './agentChat.toolLock'
import { browserCommandDecision } from './agentChat.toolLock.browser'

const ALLOWED = [
  'webterm browser open',
  'webterm browser open https://example.com',
  'webterm browser open http://example.com/docs?a=1',
  'webterm browser navigate https://bulma.io/documentation/',
  "webterm browser navigate 'https://example.com/a?x=1&y=2#frag'",
  'webterm browser snapshot',
]
const DENIED = [
  'webterm browser click e1 s1',
  'webterm browser type e1 s1 hello',
  'webterm browser eval 1+1',
  'webterm browser screenshot',
  'webterm browser download https://example.com/a.zip',
  'webterm browser status',
  // browser profiles = somebody's logins: a locked author browses signed out (registry: web.profiles is denied to it)
  'webterm browser profiles',
  'webterm browser open --profile work',
  'webterm browser open --profile work https://example.com',
  'webterm browser navigate --profile work https://example.com',
  'webterm browser press Enter',
  'webterm browser snapshot --node b1',
  'webterm browser snapshot extra',
  'webterm browser navigate',
  'webterm browser navigate --node b1 https://example.com',
  'webterm browser open --url file:///etc/passwd',
  'webterm browser open https://example.com | sh',
  'webterm browser open https://example.com; id',
  'webterm browser open https://example.com && id',
  'webterm browser open https://example.com & id',
  'webterm browser open $(id)',
  'webterm browser open `id`',
  'webterm browser open "https://example.com/$(id)"',
  'webterm browser open https://example.com > /tmp/x',
  'webterm browser open https://example.com <<EOF\nx\nEOF',
  "webterm browser open https://example.com <<'EOF'\nx\nEOF",
  'webterm browser open https://example.com\nid',
  'webterm browser open https://example.com https://example.org',
  'webterm browser navigate file:///etc/passwd',
  'webterm browser navigate data:text/html,x',
  'webterm browser navigate javascript:alert(1)',
  'webterm browser navigate chrome://settings',
  'webterm browser navigate about:blank',
  'webterm browser navigate http://127.0.0.1',
  'webterm browser navigate http://127.0.0.1:8700/api',
  'webterm browser navigate http://localhost:3000',
  'webterm browser navigate http://169.254.169.254/latest/meta-data/',
  'webterm browser navigate http://192.168.1.1/',
  'webterm browser navigate http://10.1.2.3/',
  'webterm browser navigate http://2130706433/',
  'webterm browser navigate http://[::1]/',
  'webterm browser navigate https://user:pw@example.com/',
  'webterm browser navigate example.com',
  ' webterm browser snapshot',
  'webterm  browser snapshot',
  'webterm browser snapshot\r',
  '/usr/local/bin/webterm browser snapshot',
  'webterm-browser snapshot',
]

describe('browserCommandDecision', () => {
  test('allows open, navigate and snapshot on public http(s) URLs', () => {
    for (const c of ALLOWED) expect([c, browserCommandDecision(c)]).toEqual([c, true])
  })
  test('denies every other verb, shell syntax, flag and non-public URL', () => {
    for (const c of DENIED) expect([c, browserCommandDecision(c)]).toEqual([c, false])
  })
  test('non-string command is denied', () => expect(browserCommandDecision(undefined)).toBe(false))
})

describe('skillAuthorPreToolUse with the browser family', () => {
  const run = async (tool_name: string, command: string) => {
    const out = await skillAuthorPreToolUse({ hook_event_name: 'PreToolUse', tool_name, tool_input: { command }, tool_use_id: 't' } as HookInput, 't', { signal: new AbortController().signal })
    return (out as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision
  }
  test('allows skills and browser reads, denies browser writes and other tools', async () => {
    expect(await run('Bash', 'webterm skills list')).toBe('allow')
    expect(await run('Bash', 'webterm browser navigate https://bulma.io')).toBe('allow')
    expect(await run('Bash', 'webterm browser click e1 s1')).toBe('deny')
    expect(await run('Bash', 'webterm skills list; webterm browser snapshot')).toBe('deny')
    expect(await run('WebFetch', 'webterm browser snapshot')).toBe('deny')
  })
  test('the lock allows both command families', () => {
    expect(agentChatLockFor('skill-author')?.allowedTools).toEqual(['Bash(webterm skills *)', 'Bash(webterm browser *)'])
  })
})
