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
import { preToolRuleBlock } from './permission/permission.preTool'
import type { AppendEventInput } from './events/eventModel'

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

describe('PreToolUse user rules hold in every mode (Danger included)', () => {
  // Fake policy: one human-ui rule on claude.tool:Bash with the given effect (test-only).
  const policy = (effect: 'allow' | 'ask' | 'deny') => ({
    evaluate: (_p: string, capability: string) => (capability === 'claude.tool:Bash' ? { effect, origin: 'human-ui', ruleId: 'r-1', reason: '' } : { effect: 'allow', origin: 'builtin', reason: '' }),
    store: { grants: () => [{ id: 'r-1', capability: 'claude.tool:Bash' }] },
  }) as unknown as Parameters<typeof preToolRuleBlock>[0]['policy']
  const call = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push --force' } }

  it('a Deny rule denies through the PreToolUse reply under bypass, and the decision is recorded with the mode', async () => {
    const seen: AppendEventInput[] = []
    const deps: AgentStatusDeps = {
      setStatus() {}, setTranscript() {}, workspaceFor: () => null, modeOf: () => 'danger',
      preToolRule: (a) => preToolRuleBlock({ policy: policy('deny'), record: (e) => seen.push(e) }, a),
    }
    const out = await post('dz1', call, deps)
    expect(out.status).toBe(200)
    expect(out.json.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' })
    expect(out.json.hookSpecificOutput.permissionDecisionReason).toContain('r-1')
    expect(seen[0]).toMatchObject({ kind: 'permission.decision', payload: { behavior: 'deny', by: 'rule', ruleId: 'r-1', mode: 'danger', hook: 'PreToolUse' } })
  })

  it('an ask rule under Danger is recorded as skipped and does not block; under Auto nothing happens here', () => {
    const seen: AppendEventInput[] = []
    const ask = { nodeId: 'dz2', workspaceId: 'w1', body: call }
    expect(preToolRuleBlock({ policy: policy('ask'), record: (e) => seen.push(e) }, { ...ask, mode: 'danger' })).toEqual({})
    expect(seen[0]).toMatchObject({ payload: { behavior: 'allow', by: 'rule', ruleId: 'r-1', skipped: true, mode: 'danger' } })
    expect(preToolRuleBlock({ policy: policy('ask'), record: (e) => seen.push(e) }, { ...ask, mode: 'auto' })).toEqual({})
    expect(preToolRuleBlock({ policy: policy('allow'), record: (e) => seen.push(e) }, { ...ask, mode: 'danger' })).toEqual({})
    expect(seen).toHaveLength(1)
  })
})
