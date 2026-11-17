// The hook reply is the push channel for attached canvas skills (skillAwareness.ts): a real route call, the board
// and the skill library are fakes, and the Central handle is the process-wide one `activeCa2` reads.
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

process.env.WEBTERM_DATA_DIR = join(mkdtempSync(join(tmpdir(), 'wt-hook-skills-')), 'data') // never ~/.webterm-server

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Workspace } from '../shared/workspace'
import { agentStatusRoute, type AgentStatusDeps } from './agentStatusApi'
import { setActiveCa2 } from './central/ca2Active'
import type { Ca2Handle } from './central/ca2Boot'
import { forgetHookContext } from './hookContext'

const NODE = 'agent-with-skills'

function req(body: unknown): IncomingMessage {
  const r = new EventEmitter() as unknown as IncomingMessage
  Object.assign(r, { method: 'POST', headers: {}, resume: () => undefined })
  process.nextTick(() => { r.emit('data', Buffer.from(JSON.stringify(body))); r.emit('end') })
  return r
}

function res(): ServerResponse & { body: string } {
  const out = { statusCode: 0, body: '', setHeader() {}, end(chunk?: string) { out.body = chunk ?? '' } }
  return out as unknown as ServerResponse & { body: string }
}

const board = (cabled: string[]): Workspace => ({
  id: 'w', name: 'Board', viewport: { x: 0, y: 0, zoom: 1 }, updatedAt: 1,
  nodes: [{ id: NODE, kind: 'agent', x: 0, y: 0, agentId: 'claude' }, ...cabled.map((skill, i) => ({ id: `s${i}`, kind: 'skill' as const, x: 0, y: 0, skill }))],
  bridges: cabled.map((_, i) => ({ id: `b${i}`, source: `s${i}`, target: NODE, kind: 'skill' as const })),
})

function library(): void {
  const row = (name: string) => ({ name, version: '2', audience: 'canvas', enabled: true })
  const skills = { list: (s?: string) => (s === 'active' ? [row('webterm-release'), row('webterm-triage')] : []), descriptions: () => new Map([['webterm-release', 'Ship a release.'], ['webterm-triage', 'Sort incoming bugs.']]) }
  setActiveCa2({ skills } as unknown as Ca2Handle)
}

async function hook(event: string, cabled: string[]): Promise<string> {
  const out = res()
  const deps: AgentStatusDeps = { setStatus: () => undefined, setTranscript: () => undefined, workspaceFor: () => board(cabled) }
  await agentStatusRoute(req({ hook_event_name: event }), out, new URL(`http://127.0.0.1:8700/api/agent-status?node=${NODE}`), { strictAuth: false, deps })
  return out.body ? ((JSON.parse(out.body) as { hookSpecificOutput: { additionalContext?: string } }).hookSpecificOutput.additionalContext ?? '') : ''
}

afterEach(() => { setActiveCa2(null); forgetHookContext(NODE) })

describe('attached canvas skills ride the hook reply', () => {
  it('SessionStart names the attached skills with their description; the body is never in it', async () => {
    library()
    const text = await hook('SessionStart', ['webterm-release'])
    expect(text).toContain('webterm-release (v2): Ship a release.')
    expect(text).not.toContain('webterm-triage')
    expect(text).toContain('webterm skills get <name>')
  })

  it('a cable added or removed between prompts reaches the running agent on the next prompt, no restart', async () => {
    library()
    await hook('SessionStart', ['webterm-release'])
    expect(await hook('UserPromptSubmit', ['webterm-release'])).not.toContain('webterm-release')
    expect(await hook('UserPromptSubmit', ['webterm-release', 'webterm-triage'])).toContain('webterm-triage (v2): Sort incoming bugs.')
    expect(await hook('UserPromptSubmit', ['webterm-release'])).toMatch(/no longer available[^\n]*webterm-triage/)
  })

  it('with Central skills off nothing is announced', async () => {
    expect(await hook('SessionStart', ['webterm-release'])).not.toContain('webterm-release')
  })
})
