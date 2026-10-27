import type { AgentStatus } from '../shared/workspace'

// Map a claude hook's stdin JSON to a live status. null = event we ignore.
export function hookStatus(body: { hook_event_name?: string; message?: string }): AgentStatus | null {
  switch (body.hook_event_name) {
    case 'SessionStart':
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return 'working'
    case 'Stop':
      return 'waiting'
    case 'Notification':
      // Permission prompts contain "permission"/"approve"; anything else is an idle nudge.
      return /permiss|approv/i.test(body.message ?? '') ? 'blocked' : 'waiting'
    case 'SessionEnd':
      return 'done'
    default:
      return null
  }
}

// The inline --settings object: one catch-all curl per event, POSTing hook stdin
// to our agent-status endpoint keyed by node id. Returned as an OBJECT so tests
// can assert structure without parsing shell quoting.
export function claudeHooksSettings(nodeId: string, port: number): Record<string, unknown> {
  const cmd = `curl -s 'http://127.0.0.1:${port}/api/agent-status?node=${nodeId}' --data-binary @- >/dev/null 2>&1 || true`
  const hook = { hooks: [{ type: 'command', command: cmd }] }
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification', 'SessionEnd']
  const hooks: Record<string, unknown[]> = {}
  for (const e of events) hooks[e] = [{ matcher: '', ...hook }]
  return { hooks }
}

// Single-quote a string for a POSIX shell (close-escape-reopen for embedded quotes).
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// Flags appended to the claude launch line (NO leading space; caller joins with one).
// resume=false → fresh session via --session-id; resume=true → continue via --resume.
export function buildClaudeFlags(nodeId: string, sessionId: string, port: number, resume: boolean): string {
  const idFlag = resume ? `--resume ${sessionId}` : `--session-id ${sessionId}`
  return `${idFlag} --settings ${shq(JSON.stringify(claudeHooksSettings(nodeId, port)))}`
}
