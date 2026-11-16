// The Stop hook payload becomes a parked worker result (workResult.ts); asserts the route side of that seam.
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

const SANDBOX = mkdtempSync(join(tmpdir(), 'wt-stop-result-'))
process.env.WEBTERM_DATA_DIR = join(SANDBOX, 'data')

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Workspace } from '../shared/workspace'
import { nodeToken, NODE_TOKEN_HEADER } from './hooks'
import { agentStatusRoute, MAX_HOOK_BODY_BYTES, type AgentStatusDeps } from './agentStatusApi'
import { RESULT_MAX_BYTES, takeStopResult } from './central/work/workResult'

const NODE = 'node-result-1'
const WS = { id: 'w1', nodes: [], bridges: [], edges: [] } as unknown as Workspace

function req(body: unknown): IncomingMessage {
  const r = new EventEmitter() as unknown as IncomingMessage
  Object.assign(r, { method: 'POST', headers: { [NODE_TOKEN_HEADER]: nodeToken(NODE) }, resume() {} })
  process.nextTick(() => { r.emit('data', Buffer.from(JSON.stringify(body))); r.emit('end') })
  return r
}
const res = (): ServerResponse => ({ statusCode: 0, setHeader() {}, end() {} }) as unknown as ServerResponse
const writes: string[] = []
const deps: AgentStatusDeps = { setStatus: (_n, s) => { writes.push(s) }, setTranscript() {}, workspaceFor: () => WS }
const post = (body: unknown): Promise<boolean> => agentStatusRoute(req(body), res(), new URL(`http://x/api/agent-status?node=${NODE}`), { strictAuth: true, deps })

beforeEach(() => { takeStopResult(NODE); writes.length = 0 })

// Shape of the documented Stop payload (code.claude.com/docs/en/hooks).
const stop = (extra: Record<string, unknown> = {}) => ({ session_id: 's', transcript_path: '/x/t.jsonl', cwd: '/w', hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'did it\nRESULT: 3 files changed', ...extra })

describe('Stop hook result capture at the route', () => {
  it('parks last_assistant_message with its RESULT line', async () => {
    await post(stop())
    expect(takeStopResult(NODE)).toMatchObject({ source: 'stop_hook', text: 'did it\nRESULT: 3 files changed', resultLine: '3 files changed', truncated: false })
  })

  it('StopFailure parks a failure reason, never the error string as a result', async () => {
    await post({ hook_event_name: 'StopFailure', error: 'rate_limit', error_details: 'slow down', last_assistant_message: 'API Error: 429' })
    const r = takeStopResult(NODE)
    expect(r).toMatchObject({ source: 'none', reason: 'stop_failure', failure: { error: 'rate_limit', details: 'slow down' } })
    expect(r?.text).toBe('')
  })

  it('SubagentStop parks nothing, so it cannot overwrite the parent result', async () => {
    await post(stop())
    await post({ hook_event_name: 'SubagentStop', agent_id: 'a1', last_assistant_message: 'subagent says hi' })
    expect(takeStopResult(NODE)?.text).toContain('3 files changed')
  })

  it('redacts secrets on write and caps the text at the byte limit', async () => {
    const secret = 'sk-ant-api03-' + 'A'.repeat(40)
    await post(stop({ last_assistant_message: `key ${secret} ${'z'.repeat(RESULT_MAX_BYTES * 2)}` }))
    const r = takeStopResult(NODE)
    expect(r?.text).not.toContain(secret)
    expect(r?.truncated).toBe(true)
    expect(Buffer.byteLength(r?.text ?? '')).toBeLessThanOrEqual(RESULT_MAX_BYTES)
  })

  it('a ~200 KiB message still delivers status and a capped result', async () => {
    const big = 'q'.repeat(MAX_HOOK_BODY_BYTES - 2048)
    await post(stop({ last_assistant_message: big }))
    expect(writes).toEqual(['waiting'])
    expect(takeStopResult(NODE)?.truncated).toBe(true)
  })

  it('falls back to the transcript tail when the payload has no message', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-claude-'))
    process.env.CLAUDE_CONFIG_DIR = root
    mkdirSync(join(root, 'projects'), { recursive: true })
    const file = join(root, 'projects', 't.jsonl')
    writeFileSync(file, [{ type: 'user', message: { content: 'go' } }, { type: 'assistant', message: { content: [{ type: 'text', text: 'from transcript\nRESULT: ok' }] } }].map((l) => JSON.stringify(l)).join('\n'))
    await post(stop({ transcript_path: file, last_assistant_message: undefined }))
    delete process.env.CLAUDE_CONFIG_DIR
    expect(takeStopResult(NODE)).toMatchObject({ source: 'transcript', resultLine: 'ok' })
  })

  it('an unreadable transcript does not throw and is recorded as none with a reason', async () => {
    await post(stop({ last_assistant_message: undefined }))
    expect(takeStopResult(NODE)).toMatchObject({ source: 'none', reason: expect.stringMatching(/^transcript|no_message/) })
  })
})
