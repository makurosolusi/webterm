// Grading logic of the capability smoke, on synthetic evidence (no model, no server).
import { describe, expect, test } from 'bun:test'
import { centralEvidence, chatEvidence, isNetworkFailure } from './smoke.capabilities.evidence'
import { claimsNoBrowser, gradeBrowserIntent, gradeDirect, gradeNegative, gradeRead, type Evidence, type ToolEvidence } from './smoke.capabilities.judge'

const tool = (o: Partial<ToolEvidence>): ToolEvidence => ({ id: 'toolu_000001', name: 'browser_read', command: '', state: 'ok', code: '', ...o })
const bash = (command: string, state: ToolEvidence['state'] = 'ok'): ToolEvidence => tool({ name: 'Bash', command, state })
const ev = (tools: ToolEvidence[], text = 'Judulnya Example Domain'): Evidence => ({ tools, text })

describe('claimsNoBrowser', () => {
  const claims = [
    'Saya tidak bisa membuka halaman itu.', 'Maaf, saya tidak punya alat untuk browsing.', 'Saya tidak dapat mengakses internet.',
    'I cannot open that page.', "I can't browse the web.", 'I do not have a browser tool.', "I'm unable to access URLs.", 'There is no browsing access here.',
  ]
  const clean = ['Saya sudah membaca example.com: halaman contoh.', 'I read the page; the title is Example Domain.', 'Saya membuka halaman lalu merangkumnya.']
  test('flags Indonesian and English claims of having no browser', () => { for (const t of claims) expect([t, claimsNoBrowser(t)]).toEqual([t, true]) })
  test('lets honest answers through', () => { for (const t of clean) expect([t, claimsNoBrowser(t)]).toEqual([t, false]) })
})

describe('gradeRead, central author', () => {
  test('PASS: browser_read succeeded and no refusal', () => expect(gradeRead('central', 'read', ev([tool({})], 'Saya membaca example.com.'), { author: true }).pass).toBe(true))
  test('FAIL: no browser_read call, only prose', () => expect(gradeRead('central', 'read', ev([tool({ name: 'skill_list' })]), { author: true }).evidence).toContain('never called'))
  test('FAIL: called but denied', () => expect(gradeRead('central', 'read', ev([tool({ state: 'denied', code: 'no_project_for_web_read' })]), { author: true }).evidence).toContain('no_project_for_web_read'))
  test('FAIL: tool used yet answer says it cannot open', () => expect(gradeRead('central', 'read', ev([tool({})], 'Saya tidak bisa membuka halaman itu.'), { author: true }).pass).toBe(false))
})

describe('gradeRead, chat', () => {
  test('PASS: webterm browser open + snapshot, whitelist respected', () => expect(gradeRead('chat', 'read', ev([bash('webterm browser open https://example.com/'), bash('webterm browser snapshot')], 'ok'), { author: true }).pass).toBe(true))
  test('FAIL: Bash that is not the browser CLI', () => expect(gradeRead('chat', 'read', ev([bash('curl -s https://example.com/')]), { author: false }).evidence).toContain('never called'))
  test('FAIL: author calls outside the whitelist even after a good read', () => {
    const v = gradeRead('chat', 'read', ev([bash('webterm browser snapshot'), bash('curl https://example.com/', 'denied')], 'ok'), { author: true })
    expect(v.pass).toBe(false)
    expect(v.evidence).toContain('outside whitelist')
  })
  test('non-author may use other tools (whitelist is an author rule)', () => expect(gradeRead('chat', 'title', ev([bash('webterm browser open https://example.com/'), bash('ls')]), { author: false }).pass).toBe(true))
  test('title case needs the title in the answer', () => expect(gradeRead('chat', 'title', ev([bash('webterm browser snapshot')], 'Halaman contoh.'), { author: false }).evidence).toContain('title'))
  test('title match is case-insensitive', () => expect(gradeRead('central', 'title', ev([tool({})], 'judulnya: example domain'), { author: false }).pass).toBe(true))
})

describe('gradeNegative', () => {
  test('PASS: refused with url_not_public', () => expect(gradeNegative('central', ev([tool({ state: 'denied', code: 'url_not_public' })], 'Ditolak.')).evidence).toContain('refused: browser_read'))
  test('PASS: chat lock denied the command', () => expect(gradeNegative('chat', ev([bash('webterm browser open http://127.0.0.1:8700/', 'denied')], 'Tidak diizinkan.')).pass).toBe(true))
  test('PASS: chat lock surfaces as a PreToolUse hook error', () => expect(gradeNegative('chat', ev([{ ...bash('webterm browser open http://127.0.0.1:8700/', 'failed'), code: 'PreToolUse:Bash hook error: Only one `webterm skills' }], 'Ditolak.')).pass).toBe(true))
  test('PASS but labelled: model declined without trying', () => expect(gradeNegative('chat', ev([], 'Itu alamat lokal.')).evidence).toContain('not exercised'))
  test('FAIL: loopback read succeeded', () => expect(gradeNegative('central', ev([tool({})], 'x')).pass).toBe(false))
  test('FAIL: page markup leaked into the answer', () => expect(gradeNegative('central', ev([tool({ state: 'denied', code: 'url_not_public' })], '<!doctype html><html>secret')).pass).toBe(false))
  test('FAIL: a non-whitelisted chat call succeeded', () => expect(gradeNegative('chat', ev([bash('curl http://127.0.0.1:1/', 'ok')], 'x')).pass).toBe(false))
  test('FAIL: central denial for an unrelated reason proves nothing', () => expect(gradeNegative('central', ev([tool({ state: 'denied', code: 'no_project_for_web_read' })], 'x')).evidence).toContain('not proven'))
  test('FAIL: call without success or denial code', () => expect(gradeNegative('central', ev([tool({ state: 'failed', code: 'timeout' })], 'x')).pass).toBe(false))
})

describe('evidence parsers', () => {
  test('central: denied receipt wins over card state; text only from assistant', () => {
    const e = centralEvidence([
      { role: 'human', parts: [{ type: 'text', text: 'buatkan skill' }] },
      { role: 'assistant', parts: [
        { type: 'tool', toolCallId: 't1', name: 'browser_read', state: 'failed', args: { url: 'http://127.0.0.1/' }, result: { outcome: 'denied', detail: 'url_not_public' } },
        { type: 'tool', toolCallId: 't2', name: 'skill_list', state: 'succeeded', result: { outcome: 'ok', detail: 'ok' } },
        { type: 'text', text: 'halo' },
      ] },
    ])
    expect(e.tools).toEqual([
      { id: 't1', name: 'browser_read', command: 'http://127.0.0.1/', state: 'denied', code: 'url_not_public' },
      { id: 't2', name: 'skill_list', command: '', state: 'ok', code: '' },
    ])
    expect(e.text).toBe('halo')
  })
  test('chat: the last state of a tool id wins; assistant text parts collected', () => {
    const e = chatEvidence([
      { t: 'tool', id: 'a', name: 'Bash', input: { command: 'webterm browser open https://example.com/' }, state: 'running' },
      { t: 'tool', id: 'a', name: 'Bash', input: { command: 'webterm browser open https://example.com/' }, state: 'done', result: 'ok' },
      { t: 'message', role: 'user', parts: [{ k: 'text', text: 'jangan' }] },
      { t: 'message', role: 'assistant', parts: [{ k: 'text', text: 'Example Domain' }] },
    ])
    expect(e.tools).toHaveLength(1)
    expect(e.tools[0]).toMatchObject({ state: 'ok', command: 'webterm browser open https://example.com/' })
    expect(e.text).toContain('Example Domain')
    expect(e.text).not.toContain('jangan')
  })
  test('network failures are retryable, behavior failures are not', () => {
    expect(isNetworkFailure('fetch failed ECONNRESET')).toBe(true)
    expect(isNetworkFailure('API Error 529 overloaded')).toBe(true)
    expect(isNetworkFailure('browser_read denied')).toBe(false)
  })
})

describe('gradeDirect (one message, propose succeeds, nothing asked back)', () => {
  const propose = bash("webterm skills propose --name webterm-contoh --title 'Contoh' --body-file - <<'EOF'")
  const centralPropose = tool({ name: 'mcp__webterm__skill_propose' })
  test('PASS chat: propose ok, draft stored, calm answer', () => expect(gradeDirect('chat', { tools: [bash('webterm skills list'), propose], text: 'Contoh (webterm-contoh, canvas). Draft proposed. Tell me what to change.', drafts: 1 }).pass).toBe(true))
  test('PASS central: skill_propose ok', () => expect(gradeDirect('central', { tools: [centralPropose], text: 'Draft proposed.', drafts: 1 }).pass).toBe(true))
  test('FAIL: only a questionnaire, no propose', () => expect(gradeDirect('chat', { tools: [bash('webterm skills list')], text: 'Collected: purpose. Still needed: steps.', drafts: 0 }).evidence).toContain('no propose call'))
  test('FAIL: propose failed lint', () => expect(gradeDirect('chat', { tools: [{ ...propose, state: 'failed' }], text: 'x', drafts: 0 }).evidence).toContain('never succeeded'))
  test('FAIL: propose ok but nothing in the store', () => expect(gradeDirect('central', { tools: [centralPropose], text: 'x', drafts: 0 }).evidence).toContain('no draft in the store'))
  test('FAIL: drafted but still asks for a go', () => expect(gradeDirect('chat', { tools: [propose], text: 'Draft proposed. Reply go to continue.', drafts: 1 }).pass).toBe(false))
})

describe('gradeRead alt path (chat.default, plain read)', () => {
  const fetchTool = tool({ name: 'WebFetch' })
  test('PASS (alt: WebFetch): no node, correct title', () => expect(gradeRead('chat', 'title', ev([fetchTool]), { author: false }).evidence).toContain('PASS (alt: WebFetch)'))
  test('PASS (alt: curl) through Bash', () => expect(gradeRead('chat', 'title', ev([bash('curl -sL https://example.com/')]), { author: false }).pass).toBe(true))
  test('FAIL: fetched but wrong answer', () => expect(gradeRead('chat', 'title', ev([fetchTool], 'Tidak tahu'), { author: false }).pass).toBe(false))
  test('FAIL: no fetch and no browser', () => expect(gradeRead('chat', 'title', ev([bash('ls')]), { author: false }).pass).toBe(false))
  test('author profiles get no alt', () => expect(gradeRead('chat', 'read', ev([fetchTool]), { author: true }).pass).toBe(false))
  test('Central gets no alt', () => expect(gradeRead('central', 'title', ev([fetchTool]), { author: false }).pass).toBe(false))
})

describe('gradeBrowserIntent', () => {
  const open = bash('webterm browser open https://example.com/')
  const snap = bash('webterm browser snapshot')
  const click = bash('webterm browser click e3 s1')
  test('open PASS: open + snapshot + title', () => expect(gradeBrowserIntent('open', ev([open, snap], 'Title and heading: Example Domain')).pass).toBe(true))
  test('open PASS: navigate counts as open', () => expect(gradeBrowserIntent('open', ev([bash('webterm browser navigate https://example.com/'), snap])).pass).toBe(true))
  test('open FAIL: WebFetch instead of the node', () => expect(gradeBrowserIntent('open', ev([tool({ name: 'WebFetch' })])).evidence).toContain('no successful webterm browser open'))
  test('open PASS: verbs chained with && in one Bash call', () => expect(gradeBrowserIntent('open', ev([bash('webterm browser open https://example.com/ && webterm browser snapshot')])).pass).toBe(true))
  test('open FAIL: no snapshot', () => expect(gradeBrowserIntent('open', ev([open])).evidence).toContain('snapshot'))
  test('open FAIL: title missing', () => expect(gradeBrowserIntent('open', ev([open, snap], 'a page')).evidence).toContain('missing'))
  test('open FAIL: open call failed', () => expect(gradeBrowserIntent('open', ev([bash(open.command, 'failed'), snap])).pass).toBe(false))
  test('interact PASS: click and destination reported', () => expect(gradeBrowserIntent('interact', ev([open, snap, click], 'It goes to https://www.iana.org/domains/example')).pass).toBe(true))
  test('interact PASS: type counts as acting', () => expect(gradeBrowserIntent('interact', ev([open, bash('webterm browser type e1 s1 hi')], 'iana.org')).pass).toBe(true))
  test('interact FAIL: never clicked', () => expect(gradeBrowserIntent('interact', ev([open, snap], 'iana.org')).evidence).toContain('click'))
  test('interact FAIL: destination not reported', () => expect(gradeBrowserIntent('interact', ev([open, click], 'Clicked it')).evidence).toContain('destination'))
})

import { gradeProfile, gradeProfileDenied } from './smoke.capabilities.profile'
describe('profile grading', () => {
  const t = (name: string, over: Record<string, unknown> = {}) => ({ id: 'tool-123456', name, command: '', state: 'ok', code: '', ...over }) as never
  test('steward needs browser_open with profile work and the answer naming it', () => {
    expect(gradeProfile('central', { tools: [t('mcp__webterm__browser_open', { profile: 'work' })], text: 'It uses the work profile.' }).pass).toBe(true)
    expect(gradeProfile('central', { tools: [t('mcp__webterm__browser_open', { profile: 'personal' })], text: 'work' }).pass).toBe(false)
    expect(gradeProfile('central', { tools: [t('mcp__webterm__browser_open', { profile: 'work' })], text: 'done' }).pass).toBe(false)
  })
  test('chat needs the --profile work command to succeed', () => {
    expect(gradeProfile('chat', { tools: [t('Bash', { command: 'webterm browser open --profile work https://example.com' })], text: 'work' }).pass).toBe(true)
    expect(gradeProfile('chat', { tools: [t('Bash', { command: 'webterm browser open https://example.com' })], text: 'work' }).pass).toBe(false)
  })
  test('author control fails only when a profile call succeeds', () => {
    expect(gradeProfileDenied({ tools: [t('Bash', { command: 'webterm browser open --profile work', state: 'denied' })], text: '' }).pass).toBe(true)
    expect(gradeProfileDenied({ tools: [t('Bash', { command: 'webterm browser profiles' })], text: '' }).pass).toBe(false)
  })
})
