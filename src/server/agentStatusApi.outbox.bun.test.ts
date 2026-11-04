// Bun-only: the hook route hands queued outbox `context` mail to Claude Code as additionalContext,
// exactly once, on the real outbox runtime (startOutbox: real db + store) in a temp data dir.
import { afterAll, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'

const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'status-outbox-'))
const prevDir = process.env.WEBTERM_DATA_DIR
process.env.WEBTERM_DATA_DIR = root // db + outbox land here, never in ~/.webterm-server
// The temp root is NOT removed: `db` and the started outbox are process singletons that outlive this
// file in the shared `bun test` process, so deleting their sqlite file under them made every later
// file's hook reply fail with SQLITE_IOERR. It lives under TMPDIR, which the OS cleans.
afterAll(() => {
  if (prevDir === undefined) delete process.env.WEBTERM_DATA_DIR
  else process.env.WEBTERM_DATA_DIR = prevDir
})

const { db } = await import('./db')
const { startOutbox } = await import('./outbox/outboxRuntime')
const { agentStatusRoute } = await import('./agentStatusApi')

function req(body: unknown): IncomingMessage {
  const r = Object.assign(new EventEmitter(), { method: 'POST', headers: {}, resume: () => {} }) as unknown as IncomingMessage
  process.nextTick(() => { r.emit('data', Buffer.from(JSON.stringify(body))); r.emit('end') })
  return r
}
function res() {
  const out = { statusCode: 0, body: '', setHeader() {}, end(b?: string) { out.body = b ?? '' } }
  return out
}
const deps = { setStatus() {}, setTranscript() {}, workspaceFor: () => null }

async function hook(event: string): Promise<{ status: number; context?: string }> {
  const r = res()
  await agentStatusRoute(req({ hook_event_name: event }), r as unknown as ServerResponse, new URL('http://x/api/agent-status?node=a1'), { strictAuth: false, deps })
  return { status: r.statusCode, context: r.body ? JSON.parse(r.body).hookSpecificOutput?.additionalContext : undefined }
}

test('queued context mail rides UserPromptSubmit additionalContext exactly once', async () => {
  const ws = db.create('w', root)
  db.save({ ...ws, nodes: [{ id: 'a1', kind: 'agent', agentId: 'claude', x: 0, y: 0 }] })
  const outbox = await startOutbox()
  outbox.enqueue({ to: 'a1', body: 'note from central', kind: 'context', operationId: 'ctx-1', createdBy: 'test' })
  expect(outbox.list('a1')[0]).toMatchObject({ status: 'queued' })

  expect(await hook('PostToolUse')).toEqual({ status: 204 }) // not a context event: stays queued
  expect(outbox.list('a1')[0].status).toBe('queued')

  const first = await hook('UserPromptSubmit')
  expect(first.status).toBe(200)
  expect(first.context).toContain('note from central')
  expect(outbox.list('a1')[0]).toMatchObject({ status: 'delivered', transport: 'hook' })

  expect(await hook('UserPromptSubmit')).toEqual({ status: 204 }) // never twice
})
