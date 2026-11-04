import { describe, expect, it } from 'vitest'
import { relativeTime, resumeNode, targetWorkspace } from './SessionHistory.model'
import type { AgentSession } from './SessionHistory.api'

const session = (over: Partial<AgentSession> = {}): AgentSession => ({
  agent: 'claude', id: '11111111-2222-3333-4444-555555555555', cwd: '/repo/app', title: 't',
  startedAt: 1, endedAt: 2, messageCount: 3, ...over,
})
const id = () => 'node-1'

describe('resumeNode', () => {
  it('claude: agent node carrying the transcript id as sessionId (AgentNode launches it with --resume)', () => {
    expect(resumeNode(session(), {}, id)).toMatchObject({
      id: 'node-1', kind: 'agent', agentId: 'claude', cmd: 'claude', cwd: '/repo/app',
      sessionId: '11111111-2222-3333-4444-555555555555',
    })
  })

  it('claude: honours the user launch-command override', () => {
    expect(resumeNode(session(), { claude: 'envman -e work -- claude' }, id)?.cmd).toBe('envman -e work -- claude')
  })

  it('codex: resume lives in the command, no sessionId', () => {
    const n = resumeNode(session({ agent: 'codex', id: 'cdx-9' }), {}, id)
    expect(n?.cmd).toBe('codex resume cdx-9')
    expect(n?.sessionId).toBeUndefined()
  })

  it('refuses ids that are unsafe on a shell command line', () => {
    expect(resumeNode(session({ id: '-rf; rm' }), {}, id)).toBeNull()
    expect(resumeNode(session({ agent: 'codex', id: 'a b' }), {}, id)).toBeNull()
  })

  it('omits cwd when the transcript had none (node falls back to the workspace cwd)', () => {
    expect(resumeNode(session({ cwd: null }), {}, id)).not.toHaveProperty('cwd')
  })
})

describe('targetWorkspace', () => {
  const wss = [
    { id: 'root', cwd: '/repo' },
    { id: 'app', cwd: '/repo/app/' },
    { id: 'other', cwd: '/elsewhere' },
    { id: 'nofolder' },
  ]

  it('active workspace wins when it contains the session cwd', () => {
    expect(targetWorkspace({ cwd: '/repo/app/sub' }, wss, 'root')).toBe('root')
  })

  it('otherwise the deepest workspace containing the cwd', () => {
    expect(targetWorkspace({ cwd: '/repo/app/sub' }, wss, 'other')).toBe('app')
    expect(targetWorkspace({ cwd: '/repo/app2' }, wss, 'other')).toBe('root')
  })

  it('falls back to the active workspace', () => {
    expect(targetWorkspace({ cwd: '/tmp/x' }, wss, 'other')).toBe('other')
    expect(targetWorkspace({ cwd: null }, wss, 'nofolder')).toBe('nofolder')
  })
})

describe('relativeTime', () => {
  const now = Date.UTC(2026, 0, 10)
  it('formats recent times', () => {
    expect(relativeTime(null, now)).toBe('')
    expect(relativeTime(now - 10_000, now)).toBe('just now')
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m ago')
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2d ago')
  })
})
