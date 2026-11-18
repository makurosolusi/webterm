// Grading logic and the local site of the tab smoke cases, on synthetic evidence (no model, no server).
import { describe, expect, test } from 'bun:test'
import type { Evidence, ToolEvidence } from './smoke.capabilities.judge'
import { HEADING_B, gradeTabDenied, gradeTabMulti, gradeTabOpen, startTabsSite } from './smoke.capabilities.tabs'

const tool = (o: Partial<ToolEvidence>): ToolEvidence => ({ id: 'toolu_000001', name: 'Bash', command: '', state: 'ok', code: '', ...o })
const click = (output = '{"ok":true,"data":{"ok":true,"newTab":"tab-1","note":"Opened a new tab"}}'): ToolEvidence => tool({ command: 'webterm browser click e1 s1', output })
const ev = (tools: ToolEvidence[], text: string, newBrowserNodes?: number): Evidence => ({ tools, text, ...(newBrowserNodes === undefined ? {} : { newBrowserNodes }) })

describe('gradeTabOpen (chat.default)', () => {
  test('PASS: click answered newTab, heading reported, one new node', () => expect(gradeTabOpen(ev([click()], `The heading is ${HEADING_B}`, 1)).pass).toBe(true))
  test('FAIL: the click did not open a tab (no newTab in the answer)', () => expect(gradeTabOpen(ev([click('{"ok":true,"data":{"ok":true}}')], HEADING_B, 1)).evidence).toContain('newTab'))
  test('FAIL: heading missing', () => expect(gradeTabOpen(ev([click()], 'It worked', 1)).evidence).toContain(HEADING_B))
  test('FAIL: a second browser node was opened instead of using the tab', () => expect(gradeTabOpen(ev([click()], HEADING_B, 2)).evidence).toContain('exactly one browser node'))
  test('FAIL: no node added at all (the chat never opened its own browser)', () => expect(gradeTabOpen(ev([click()], HEADING_B, 0)).pass).toBe(false))
})

describe('gradeTabMulti (central.steward)', () => {
  const tab = (o: Partial<ToolEvidence> = {}) => tool({ name: 'mcp__webterm__browser_tab', command: 'http://127.0.0.1:1/c', ...o })
  test('PASS: browser_tab new, both titles, one node (or an idle one reused)', () => {
    expect(gradeTabMulti(ev([tab()], 'Page A and Page C', 1)).pass).toBe(true)
    expect(gradeTabMulti(ev([tab()], 'Page A and Page C', 0)).pass).toBe(true)
  })
  test('FAIL: no browser_tab with a url', () => expect(gradeTabMulti(ev([tab({ command: '' })], 'Page A, Page C', 1)).evidence).toContain('no successful browser_tab'))
  test('FAIL: a title is missing', () => expect(gradeTabMulti(ev([tab()], 'Page A only', 1)).evidence).toContain('Page C'))
  test('FAIL: two nodes were added', () => expect(gradeTabMulti(ev([tab()], 'Page A Page C', 2)).evidence).toContain('more than one browser node'))
})

describe('gradeTabDenied (chat.skill-author)', () => {
  test('PASS: refused', () => expect(gradeTabDenied(ev([tool({ command: 'webterm browser tab new http://x/', state: 'denied' })], 'no')).evidence).toContain('refused'))
  test('PASS but labelled: no attempt', () => expect(gradeTabDenied(ev([], 'no')).evidence).toContain('not exercised'))
  test('FAIL: a tab verb succeeded', () => expect(gradeTabDenied(ev([tool({ command: 'webterm browser tabs' })], 'x')).pass).toBe(false))
  test('FAIL: --tab on another verb succeeded', () => expect(gradeTabDenied(ev([tool({ command: 'webterm browser snapshot --tab t2' })], 'x')).pass).toBe(false))
})

describe('local tab site', () => {
  test('page A links to B with target=_blank; B has the heading; unknown path is 404; stops cleanly', async () => {
    const site = await startTabsSite()
    try {
      const a = await (await fetch(`http://127.0.0.1:${site.port}/`)).text()
      expect(a).toContain('<title>Page A</title>')
      expect(a).toContain('<a href="/b" target="_blank">Open B</a>')
      expect(await (await fetch(`http://127.0.0.1:${site.port}/b`)).text()).toContain(`<h1>${HEADING_B}</h1>`)
      expect((await fetch(`http://127.0.0.1:${site.port}/zzz`)).status).toBe(404)
    } finally {
      site.stop()
    }
  })
})
