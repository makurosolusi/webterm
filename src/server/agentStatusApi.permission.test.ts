// The hook route's F3-b replies: PermissionRequest answered from `answerPermission`, and the
// PreToolUse doom-loop guard. Real route, fake request/response and registry deps (node-env).
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const checkpoint = vi.hoisted(() => ({ takeCheckpointSafe: vi.fn(async () => null) }))
vi.mock('./checkpoint/checkpoint.service', () => checkpoint)

process.env.WEBTERM_DATA_DIR = join(mkdtempSync(join(tmpdir(), 'wt-perm-route-')), 'data')

import type { IncomingMessage, ServerResponse } from 'node:http'
import { agentStatusRoute, type AgentStatusDeps } from './agentStatusApi'
import { eventBus } from './events/eventBus'
import type { SenseEvent } from './events/eventModel'
import { permissionDecision } from './permission/permission.model'
import type { PermissionAsk } from './permission/permission.wait'

function req(body: unknown): IncomingMessage {
  const r = Object.assign(new EventEmitter(), { method: 'POST', headers: {}, resume: () => {} }) as unknown as IncomingMessage
  process.nextTick(() => { r.emit('data', Buffer.from(JSON.stringify(body))); r.emit('end') })
  return r
}
function res() {
  const out = { statusCode: 0, body: '', writableEnded: false, setHeader() {}, on() {}, end(b?: string) { out.body = b ?? ''; out.writableEnded = true } }
  return out
}
const ws = { id: 'w1', name: 'w', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: 'n1', kind: 'agent', x: 0, y: 0, title: 'brisk-otter' }], bridges: [], updatedAt: 0 }

async function post(node: string, body: unknown, deps: AgentStatusDeps) {
  const r = res()
  await agentStatusRoute(req(body), r as unknown as ServerResponse, new URL(`http://x/api/agent-status?node=${node}`), { strictAuth: false, deps })
  return { status: r.statusCode, json: r.body ? JSON.parse(r.body) : undefined }
}

describe('PermissionRequest reply', () => {
  it('returns the decision JSON from answerPermission, with the node title in the ask', async () => {
    const asks: PermissionAsk[] = []
    const deps: AgentStatusDeps = {
      setStatus() {}, setTranscript() {}, workspaceFor: () => null,
      answerPermission: async (a) => { asks.push(a); return permissionDecision('deny', 'no') },
    }
    const out = await post('n1', { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm publish' } }, deps)
    expect(out.status).toBe(200)
    expect(out.json.hookSpecificOutput).toMatchObject({ hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'no' } })
    expect(asks[0]).toMatchObject({ nodeId: 'n1', nodeTitle: 'n1', workspaceId: null })
  })

  it('no decision = 204, so Claude shows its own prompt', async () => {
    const deps: AgentStatusDeps = { setStatus() {}, setTranscript() {}, workspaceFor: () => null, answerPermission: async () => null }
    expect((await post('n1', { hook_event_name: 'PermissionRequest', tool_name: 'Bash' }, deps)).status).toBe(204)
  })

  it('uses the canvas title of the node', async () => {
    let title = ''
    const deps = {
      setStatus() {}, setTranscript() {}, workspaceFor: () => ws as never,
      answerPermission: async (a: PermissionAsk) => { title = a.nodeTitle; return null },
    }
    await post('n1', { hook_event_name: 'PermissionRequest', tool_name: 'Bash' }, deps)
    expect(title).toBe('brisk-otter')
  })
})

describe('PreToolUse doom-loop guard', () => {
  it('denies the 3rd identical consecutive call with a reason and records an event', async () => {
    const seen: SenseEvent[] = []
    const off = eventBus.subscribe('permission.doom_loop', (e) => { seen.push(e) })
    const deps: AgentStatusDeps = { setStatus() {}, setTranscript() {}, workspaceFor: () => null }
    const call = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } }
    expect((await post('loop1', call, deps)).status).toBe(204)
    expect((await post('loop1', call, deps)).status).toBe(204)
    const third = await post('loop1', call, deps)
    off()
    expect(third.status).toBe(200)
    expect(third.json.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' })
    expect(third.json.hookSpecificOutput.permissionDecisionReason).toContain('Bash(npm test)')
    expect(seen[0]).toMatchObject({ nodeId: 'loop1', payload: { count: 3, behavior: 'deny' } })
  })
})

describe('UserPromptSubmit checkpoint (F3-c)', () => {
  it('takes exactly one prompt checkpoint of the node workspace; other events take none', async () => {
    checkpoint.takeCheckpointSafe.mockClear()
    const deps = { setStatus() {}, setTranscript() {}, workspaceFor: () => ws as never }
    await post('n1', { hook_event_name: 'PostToolUse' }, deps)
    expect(checkpoint.takeCheckpointSafe).not.toHaveBeenCalled()
    await post('n1', { hook_event_name: 'UserPromptSubmit', prompt: 'go' }, deps)
    expect(checkpoint.takeCheckpointSafe).toHaveBeenCalledTimes(1)
    expect(checkpoint.takeCheckpointSafe).toHaveBeenCalledWith(ws, { reason: 'prompt', nodeId: 'n1' })
  })
})
