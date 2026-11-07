// Optional LLM morning brief (F5-c): off by default, persisted toggle, never contradicts the deterministic
// counts, fails closed to the lines. The model is always a fake.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { StructuredCall } from '../central/context/claudeStructured'
import { buildBrief, type BriefEvent } from './brief.model'
import { agreesWithBrief, narrateBrief, numbersIn } from './brief.narrative'
import { createBriefService } from './brief.service'
import { BRIEF_LLM_OFF_PATH, BRIEF_LLM_ON_PATH, BRIEF_NARRATIVE_PATH, briefRoute } from './brief.route'

const DIR = mkdtempSync(join(tmpdir(), 'webterm-brief-llm-'))
afterAll(() => rmSync(DIR, { recursive: true, force: true }))
let n = 0
const T0 = 1_700_000_000_000

const events: BriefEvent[] = [
  { ts: T0 + 1, kind: 'hook.Stop', nodeId: 'a', workspaceId: 'w', payload: {} },
  { ts: T0 + 2, kind: 'hook.Stop', nodeId: 'a', workspaceId: 'w', payload: {} },
  { ts: T0 + 3, kind: 'test.fail', nodeId: 'b', workspaceId: 'w', payload: {} },
]
const brief = buildBrief({ since: T0, now: T0 + 10, headSeq: 3, events, inbox: { needsYou: 3, review: 0 }, usage: null, nodeLabel: (id) => `Agent ${id}`, workspaceLabel: (id) => id })
const answer = (narrative: unknown): StructuredCall => async () => ({ narrative })

function service(narrate?: StructuredCall) {
  return createBriefService({
    statePath: join(DIR, `state-${++n}.json`), now: () => T0 + 10,
    read: () => ({ events, headSeq: 3, inbox: { needsYou: 3, review: 0 }, usage: null }), headSeq: () => 3,
    nodeLabel: (id) => `Agent ${id}`, workspaceLabel: (id) => id, ...(narrate ? { narrate } : {}),
  })
}

describe('number check', () => {
  it('reads digits and number words', () => {
    expect(numbersIn('Two agents, 3 approvals, $0.12 and 12.3k tokens')).toEqual(['3', '0.12', '12.3', '2'])
  })
  it('accepts a paragraph using only the brief numbers and rejects any other count', () => {
    expect(brief.lines.map((l) => l.text)).toContain('3 approval or blocked tasks waiting in the Central chat')
    expect(agreesWithBrief('Three approvals wait in the Inbox; Agent a finished 2 turns.', brief)).toBe(true)
    expect(agreesWithBrief('Four approvals wait in the Inbox.', brief)).toBe(false)
    expect(agreesWithBrief('5 approvals wait.', brief)).toBe(false)
  })
})

describe('narrateBrief', () => {
  it('uses a valid paragraph and drops one that contradicts the counts', async () => {
    expect(await narrateBrief(answer('3 approvals need you; Agent b failed.'), brief)).toEqual({ narrative: '3 approvals need you; Agent b failed.', reason: 'ok' })
    expect(await narrateBrief(answer('7 approvals need you.'), brief)).toEqual({ narrative: null, reason: 'contradicts' })
  })
  it('fails closed on a malformed answer, an error and a timeout', async () => {
    expect((await narrateBrief(async () => ({ text: 'x' }), brief)).reason).toBe('invalid')
    expect((await narrateBrief(async () => { throw new Error('down') }, brief)).reason).toBe('failed')
    const hang: StructuredCall = (_r, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
    expect((await narrateBrief(hang, brief, 20)).reason).toBe('failed')
  })
  it('never calls the model for an empty brief', async () => {
    const empty = { ...brief, lines: [] }
    expect(await narrateBrief(async () => { throw new Error('must not run') }, empty)).toEqual({ narrative: null, reason: 'empty' })
  })
})

describe('brief service toggle', () => {
  it('is off by default and never calls the model while off', async () => {
    let calls = 0
    const svc = service(async () => { calls += 1; return { narrative: 'x' } })
    expect(svc.get().llm).toBe(false)
    expect(await svc.narrative()).toEqual({ narrative: null, reason: 'off' })
    expect(calls).toBe(0)
    svc.stop()
  })
  it('on: generates once per brief and the deterministic lines are unchanged', async () => {
    let calls = 0
    const svc = service(async () => { calls += 1; return { narrative: 'Agent a finished 2 turns.' } })
    const before = svc.get().lines
    expect(svc.setLlm(true).llm).toBe(true)
    expect(await svc.narrative()).toEqual({ narrative: 'Agent a finished 2 turns.', reason: 'ok' })
    await svc.narrative()
    expect(calls).toBe(1)
    expect(svc.get().lines).toEqual(before)
    svc.stop()
  })
  it('route switches and persists the toggle', async () => {
    const svc = service(answer('Agent b failed.'))
    expect((await briefRoute(BRIEF_LLM_ON_PATH, 'GET', svc))?.status).toBe(405)
    expect(((await briefRoute(BRIEF_LLM_ON_PATH, 'POST', svc))?.body as { llm: boolean }).llm).toBe(true)
    expect((await briefRoute(BRIEF_NARRATIVE_PATH, 'GET', svc))?.body).toEqual({ narrative: 'Agent b failed.', reason: 'ok' })
    expect(svc.state().llm).toBe(true)
    expect(((await briefRoute(BRIEF_LLM_OFF_PATH, 'POST', svc))?.body as { llm: boolean }).llm).toBe(false)
    svc.stop()
  })
})
