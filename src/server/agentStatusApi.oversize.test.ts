// A hook body past the cap keeps its status: only a bounded prefix is held and scanned, never a 413.
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

const SANDBOX = mkdtempSync(join(tmpdir(), 'wt-hook-oversize-'))
process.env.WEBTERM_DATA_DIR = join(SANDBOX, 'data')

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Workspace } from '../shared/workspace'
import { nodeToken, NODE_TOKEN_HEADER } from './hooks'
import { agentStatusRoute, MAX_HOOK_BODY_BYTES, type AgentStatusDeps } from './agentStatusApi'
import { readHookBody } from './agentStatusBody'
import { scanHookPrefix } from './agentStatusPrefix'
import { readCappedBody } from './channels/channelHttp'
import { RESULT_MAX_BYTES, takeStopResult } from './central/work/workResult'
import { logBus } from './logs/logBus'

const NODE = 'node-oversize-1'
const WS = { id: 'w1', nodes: [], bridges: [], edges: [] } as unknown as Workspace
const CHUNK = 64 * 1024

interface FakeReq extends IncomingMessage { emitted: number }

/** Streams `body` in chunks for as long as someone listens, counting the bytes actually delivered. */
function req(body: string | Buffer, headers: Record<string, string> = { [NODE_TOKEN_HEADER]: nodeToken(NODE) }): FakeReq {
  const buf = typeof body === 'string' ? Buffer.from(body) : body
  const r = new EventEmitter() as unknown as FakeReq
  Object.assign(r, { method: 'POST', headers, emitted: 0, resume() {} })
  process.nextTick(() => {
    for (let at = 0; at < buf.length && r.listenerCount('data') > 0; at += CHUNK) {
      const piece = buf.subarray(at, at + CHUNK)
      r.emitted += piece.length
      r.emit('data', piece)
    }
    if (r.listenerCount('end') > 0) r.emit('end')
  })
  return r
}

const res = (): ServerResponse & { body: string } => {
  const o = { statusCode: 0, body: '', setHeader() {}, end(c?: string) { o.body = c ?? '' } }
  return o as unknown as ServerResponse & { body: string }
}
const writes: string[] = []
const deps: AgentStatusDeps = { setStatus: (_n, s) => { writes.push(s) }, setTranscript() {}, workspaceFor: () => WS }
const post = (r: IncomingMessage, out = res()): Promise<ServerResponse & { body: string }> =>
  agentStatusRoute(r, out, new URL(`http://x/api/agent-status?node=${NODE}`), { strictAuth: true, deps }).then(() => out)

beforeEach(() => { takeStopResult(NODE); writes.length = 0 })

const BIG = (n = MAX_HOOK_BODY_BYTES * 2): string => 'q'.repeat(n)
const head = { session_id: 's', transcript_path: '/x/t.jsonl', cwd: '/w' }

describe('oversize hook body keeps its status', () => {
  it('(a) Stop past the cap: status reported, readable head of the message kept, truncated, 200 not 413', async () => {
    const out = await post(req(JSON.stringify({ ...head, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: BIG() })))
    expect(out.statusCode).toBe(200)
    expect(JSON.parse(out.body)).toEqual({ truncated: true })
    expect(writes).toEqual(['waiting'])
    const r = takeStopResult(NODE)
    expect(r).toMatchObject({ source: 'stop_hook', truncated: true })
    expect(Buffer.byteLength(r?.text ?? '')).toBe(RESULT_MAX_BYTES)
  })

  it('(a) Stop whose message is not in the prefix: explicit none:payload_too_large, status still set', async () => {
    const out = await post(req(JSON.stringify({ ...head, hook_event_name: 'Stop', pad: BIG(), last_assistant_message: 'late' })))
    expect(out.statusCode).toBe(200)
    expect(writes).toEqual(['waiting'])
    expect(takeStopResult(NODE)).toMatchObject({ source: 'none', reason: 'payload_too_large', truncated: false })
  })

  it('(b) oversize StopFailure still maps its failure class from the small fields', async () => {
    await post(req(JSON.stringify({ ...head, hook_event_name: 'StopFailure', error: 'rate_limit', error_details: 'slow down', last_assistant_message: BIG() })))
    expect(writes).toEqual(['waiting'])
    expect(takeStopResult(NODE)).toMatchObject({ source: 'none', reason: 'stop_failure', failure: { error: 'rate_limit', kind: 'rate_limited' } })
  })

  it('(c) an invalid token with a huge body is refused without reading a byte', async () => {
    const r = req(BIG(8 * 1024 * 1024), { [NODE_TOKEN_HEADER]: 'not-a-token' })
    const out = await post(r)
    expect(out.statusCode).toBe(403)
    expect(r.emitted).toBe(0)
    expect(r.listenerCount('data')).toBe(0)
    expect(writes).toEqual([])
  })

  it('(d) memory stays bounded: a multi-MiB stream is cut right after the cap', async () => {
    const r = req(BIG(8 * 1024 * 1024))
    const read = await readHookBody(r)
    expect(read.oversize).toBe(true)
    expect(r.emitted).toBeLessThanOrEqual(MAX_HOOK_BODY_BYTES + CHUNK)
    expect(read.bytes).toBeLessThanOrEqual(MAX_HOOK_BODY_BYTES + CHUNK)
    expect(r.listenerCount('data')).toBe(0)
  })

  it('(e) other routes keep the strict 413 of readCappedBody', async () => {
    expect(await readCappedBody(req(BIG(CHUNK * 2)), CHUNK)).toEqual({ ok: false, reason: 'too_large' })
  })

  it('(g) a normal body is untouched: 204, no truncated flag, full result', async () => {
    const out = await post(req(JSON.stringify({ ...head, hook_event_name: 'Stop', last_assistant_message: 'done\nRESULT: ok' })))
    expect(out.statusCode).toBe(204)
    expect(takeStopResult(NODE)).toMatchObject({ source: 'stop_hook', text: 'done\nRESULT: ok', truncated: false })
  })

  it('decides no permission/tool rule on an oversize body (its tool input was lost)', async () => {
    let asked = 0
    const d: AgentStatusDeps = { ...deps, preToolRule: () => { asked++; return {} }, answerPermission: async () => { asked++; return null } }
    for (const hook_event_name of ['PreToolUse', 'PermissionRequest']) {
      const r = req(JSON.stringify({ hook_event_name, tool_name: 'Bash', tool_input: { command: BIG() } }))
      await agentStatusRoute(r, res(), new URL(`http://x/api/agent-status?node=${NODE}`), { strictAuth: true, deps: d })
    }
    expect(asked).toBe(0)
    expect(writes).toEqual(['working', 'blocked'])
  })

  it('(h) the warning carries size, event and node only, never the message', async () => {
    logBus.clear()
    await post(req(JSON.stringify({ ...head, hook_event_name: 'Stop', last_assistant_message: 'SECRET-MARKER-' + BIG() })))
    const dump = JSON.stringify(logBus.snapshot())
    expect(dump).toContain('hooks.oversize')
    expect(dump).not.toContain('SECRET-MARKER')
    expect(dump).not.toContain('qqqq')
  })
})

describe('scanHookPrefix', () => {
  it('(f) a prefix cut inside a string never throws and invents no event', () => {
    const cut = '{"session_id":"s","hook_event_name":"StopFailure","error":"rate_li'
    expect(scanHookPrefix(cut)).toEqual({ session_id: 's', hook_event_name: 'StopFailure' })
    expect(scanHookPrefix('{"hook_event_name":"Sto')).toEqual({})
    expect(scanHookPrefix('{"stop_hook_active":tr')).toEqual({})
    for (const junk of ['', '[', '{"', '{"a', '{"a":', '{"a":"\\', 'not json', '{"a":{"b":[1,{"c":"d']) expect(() => scanHookPrefix(junk)).not.toThrow()
  })

  it('(f) keys quoted inside a message value are not top-level fields', () => {
    const msg = JSON.stringify('say "hook_event_name":"UserPromptSubmit", "error":"x"')
    expect(scanHookPrefix(`{"hook_event_name":"Stop","last_assistant_message":${msg}`.slice(0, -4))).toMatchObject({ hook_event_name: 'Stop' })
    expect(scanHookPrefix(`{"last_assistant_message":${msg},"hook_event_name":"Stop"}`)).toMatchObject({ hook_event_name: 'Stop' })
    expect(scanHookPrefix(`{"tool_input":{"hook_event_name":"Stop"},"x":1}`)).toEqual({})
  })

  it('keeps the head of a cut message, dropping a half escape, and only whitelisted fields', () => {
    expect(scanHookPrefix('{"last_assistant_message":"line1\\nline2 \\u00e')).toEqual({ last_assistant_message: 'line1\nline2 ' })
    expect(scanHookPrefix('{"cwd":"/w","stop_hook_active":true,"hook_event_name":"Stop","other":1}')).toEqual({ stop_hook_active: true, hook_event_name: 'Stop' })
  })
})
