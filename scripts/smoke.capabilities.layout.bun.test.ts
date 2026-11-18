// Grading logic and the local site of the split-layout smoke cases, on synthetic evidence (no model, no server).
import { describe, expect, test } from 'bun:test'
import type { Evidence, ToolEvidence } from './smoke.capabilities.judge'
import { HEADING_ALPHA, HEADING_BETA, gradeLayoutCentral, gradeLayoutChat, gradeLayoutDenied, layoutPrompt, startLayoutSite } from './smoke.capabilities.layout'

const tool = (o: Partial<ToolEvidence>): ToolEvidence => ({ id: 'toolu_000001', name: 'Bash', command: '', state: 'ok', code: '', ...o })
const set = (o: Partial<ToolEvidence> = {}) => tool({ command: 'webterm browser layout set h new:http://127.0.0.1:1/a new:http://127.0.0.1:1/b', ...o })
const ev = (tools: ToolEvidence[], text: string, newBrowserNodes?: number): Evidence => ({ tools, text, ...(newBrowserNodes === undefined ? {} : { newBrowserNodes }) })
const BOTH = `${HEADING_ALPHA} and ${HEADING_BETA}`

describe('gradeLayoutChat (chat.default)', () => {
  test('PASS: layout set ran, both headings, exactly one node', () => expect(gradeLayoutChat(ev([set()], BOTH, 1)).pass).toBe(true))
  test('FAIL: the model never set a layout (a read of it does not count)', () => {
    expect(gradeLayoutChat(ev([tool({ command: 'webterm browser layout get' })], BOTH, 1)).evidence).toContain('no successful')
    expect(gradeLayoutChat(ev([set({ state: 'denied' })], BOTH, 1)).pass).toBe(false)
  })
  test('FAIL: a heading is missing', () => expect(gradeLayoutChat(ev([set()], HEADING_ALPHA, 1)).evidence).toContain(HEADING_BETA))
  test('FAIL: two nodes (it opened a browser per page), or none', () => {
    expect(gradeLayoutChat(ev([set()], BOTH, 2)).evidence).toContain('more than 1')
    expect(gradeLayoutChat(ev([set()], BOTH, 0)).evidence).toContain('exactly one')
  })
})

describe('gradeLayoutCentral (central.steward)', () => {
  const lay = (o: Partial<ToolEvidence> = {}) => tool({ name: 'mcp__webterm__browser_layout', command: '{"nodeId":"b1","action":"set","spec":"h new:http://127.0.0.1:1/a new:http://127.0.0.1:1/b"}', ...o })
  test('PASS with one node or a reused idle one', () => {
    expect(gradeLayoutCentral(ev([lay()], BOTH, 1)).pass).toBe(true)
    expect(gradeLayoutCentral(ev([lay()], BOTH, 0)).pass).toBe(true)
  })
  test('FAIL: only a get, two nodes, or a missing heading', () => {
    expect(gradeLayoutCentral(ev([lay({ command: '{"action":"get"}' })], BOTH, 1)).pass).toBe(false)
    expect(gradeLayoutCentral(ev([lay()], BOTH, 2)).pass).toBe(false)
    expect(gradeLayoutCentral(ev([lay()], HEADING_BETA, 1)).evidence).toContain(HEADING_ALPHA)
  })
})

describe('gradeLayoutDenied (chat.skill-author)', () => {
  test('PASS: refused', () => expect(gradeLayoutDenied(ev([set({ state: 'denied' })], 'no')).evidence).toContain('refused'))
  test('PASS but labelled: no attempt', () => expect(gradeLayoutDenied(ev([], 'no')).evidence).toContain('not exercised'))
  test('FAIL: a layout verb or --all succeeded', () => {
    expect(gradeLayoutDenied(ev([set()], 'x')).pass).toBe(false)
    expect(gradeLayoutDenied(ev([tool({ command: 'webterm browser snapshot --all' })], 'x')).pass).toBe(false)
  })
})

describe('local layout site', () => {
  test('serves two different pages, 404 elsewhere, and stops cleanly; the prompt names both', async () => {
    const site = await startLayoutSite()
    try {
      expect(await (await fetch(`http://127.0.0.1:${site.port}/a`)).text()).toContain(`<h1>${HEADING_ALPHA}</h1>`)
      expect(await (await fetch(`http://127.0.0.1:${site.port}/b`)).text()).toContain(`<h1>${HEADING_BETA}</h1>`)
      expect((await fetch(`http://127.0.0.1:${site.port}/zzz`)).status).toBe(404)
      expect(layoutPrompt(site.port)).toContain(`:${site.port}/a`)
      expect(layoutPrompt(site.port)).toContain('side by side in one browser node')
    } finally {
      site.stop()
    }
  })
})
