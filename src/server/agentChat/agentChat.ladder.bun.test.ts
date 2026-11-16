// Agent chat follows the model ladder when the node has no explicit model: SDK options, live reset,
// the workspace override (Settings `projectModels`), and the picker's Auto label.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import { freshDb } from '../central/guard/controlGuard.testutil'
import { decideApproval } from '../ledger/ledgerApproval'
import type { LedgerRuntime } from '../ledger/ledgerRuntime'
import { setActiveLedgerRuntime } from '../ledger/ledgerRuntimeState'
import { requestFableGrant, stampFableScope } from '../models/fableGrant'
import { registerModelSettings } from '../models/modelOverride'
import { parseConfigPatch } from './agentChat.controls'
import { agentChatLadderLabel, agentChatLadderPick, withLadderDefault, withLadderEntry } from './agentChat.ladder'
import { buildAgentChatOptions } from './agentChat.options'
import { FakeQuery } from './agentChat.fakeQuery'
import { AgentChatSession } from './agentChat.session'

const allow: CanUseTool = async (_n, input) => ({ behavior: 'allow', updatedInput: input })
const parentEnv = { PATH: '/usr/bin:/bin', HOME: '/home/test', CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'agent-chat-ladder-')) } // test-only
const build = (over: Partial<Parameters<typeof buildAgentChatOptions>[0]> = {}) =>
  buildAgentChatOptions({ nodeId: 'n-l', port: 8701, cwd: '/tmp/proj', mode: 'auto', canUseTool: allow, abort: new AbortController(), parentEnv, workspaceId: 'w1', ...over }).options
const overrides = (map: Record<string, unknown>) => registerModelSettings(() => ({ projectModels: map }))

afterEach(() => registerModelSettings(() => ({})))

describe('agent chat on the model ladder', () => {
  test('no explicit model: options carry the ladder default (sonnet / medium)', () => {
    const o = build()
    expect(o.model).toBe('sonnet')
    expect(o.effort).toBe('medium')
    expect(build({ config: { model: 'default', thinking: true } }).model).toBe('sonnet') // the Auto entry, or a pre-ladder stored config
  })

  test('the workspace override picks the model (and its effort) for that workspace only', () => {
    overrides({ w1: { model: 'opus' }, w2: { effort: 'low' } })
    expect([build().model, build().effort]).toEqual(['opus', 'high'])
    expect([build({ workspaceId: 'w2' }).model, build({ workspaceId: 'w2' }).effort]).toEqual(['sonnet', 'low'])
    expect(build({ workspaceId: 'w3' }).model).toBe('sonnet')
  })

  test('an explicit per-node choice wins over ladder and override', () => {
    overrides({ w1: { model: 'opus', effort: 'max' } })
    const o = build({ config: { model: 'haiku', thinking: true } })
    expect(o.model).toBe('haiku')
    expect(o.effort).toBe(undefined) // an explicit model keeps the CLI's own effort for it
    expect(build({ config: { effort: 'low', thinking: false } })).toMatchObject({ model: 'opus', effort: 'low', thinking: { type: 'disabled' } })
  })

  test('Fable (per node, or from the workspace override) runs on Opus until a person grants it for the node or workspace', () => {
    expect(build({ config: { model: 'fable', thinking: true } }).model).toBe('opus')
    expect(build({ config: { model: 'claude-fable-5-1', thinking: true } }).model).toBe('opus')
    overrides({ w1: { model: 'fable' } })
    expect(build().model).toBe('opus')
    const db = freshDb()
    setActiveLedgerRuntime({ db } as unknown as LedgerRuntime)
    try {
      const id = requestFableGrant({ db, now: Date.now }, { kind: 'node', id: 'n-l', projectId: 'w1' })!
      const c = db.query('SELECT d.action_digest AS digest, d.nonce FROM approval a JOIN decision d ON d.id = a.decision_id WHERE a.id = ?').get(id) as { digest: string; nonce: string }
      decideApproval({ db, now: Date.now }, id, { actor: 'human:loopback', approve: true, ...c })
      stampFableScope({ db, now: Date.now }, id, 'human:loopback', 'target')
      expect(build({ config: { model: 'fable', thinking: true } }).model).toBe('fable')
      expect(build({ nodeId: 'other', config: { model: 'fable', thinking: true } }).model).toBe('opus') // the grant was for n-l only
    } finally {
      setActiveLedgerRuntime(null)
    }
  })

  test('picking Auto in the picker clears the explicit model', () => {
    expect(parseConfigPatch({ model: 'default' })).toEqual({ patch: { model: null } })
    expect(withLadderDefault({ thinking: true }, agentChatLadderPick('w1'))).toEqual({ thinking: true, model: 'sonnet', effort: 'medium' })
  })

  test('the Auto label names the resolved default: ladder, else the workspace override', () => {
    const list = [{ value: 'default', displayName: 'Default (recommended)', efforts: ['low'] }, { value: 'opus', displayName: 'Opus', efforts: ['low', 'high', 'max'] }]
    expect(withLadderEntry(list, agentChatLadderPick('w1'))[0]).toEqual({ value: 'default', displayName: 'Auto (ladder: Sonnet · medium)', description: 'Picked by the model ladder', efforts: ['low'] })
    overrides({ w1: { model: 'opus' } })
    const withOverride = withLadderEntry(list, agentChatLadderPick('w1'))
    expect(withOverride[0]).toMatchObject({ displayName: 'Auto (workspace: Opus · high)', efforts: ['low', 'high', 'max'] })
    expect(withOverride).toHaveLength(2)
    expect(withLadderEntry([{ value: 'opus', displayName: 'Opus' }], agentChatLadderPick('w9')).map((m) => m.value)).toEqual(['default', 'opus'])
    expect(agentChatLadderLabel({ model: null, effort: null, tier: 'T0', reason: 'x' })).toBe('Auto (ladder: CLI default)')
  })

  test('live: clearing an explicit model goes back to the ladder pick, not the CLI default', async () => {
    let fq: FakeQuery | undefined
    const s = new AgentChatSession({
      nodeId: 'n-live', gate: { request: async () => ({ behavior: 'allow' }) }, onSessionId: () => {},
      open: (_r, _c, _a, input) => { fq = new FakeQuery(input.prompt); return fq.asQuery() },
      ladder: () => agentChatLadderPick('w1'),
    })
    s.send('hi')
    await s.setConfig({ model: 'haiku' })
    await s.setConfig({ model: null })
    expect(fq?.controls).toEqual(['setModel:haiku', 'effort:default', 'setModel:sonnet', 'effort:medium'])
    s.close()
  })
})
