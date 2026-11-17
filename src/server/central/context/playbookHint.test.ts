import { describe, expect, it } from 'vitest'
import { renderCapabilityMap } from './capabilityMap'
import { matchPlaybook, playbookHintLine } from './playbookHint'

describe('matchPlaybook', () => {
  it('turns the Indonesian GitHub trending request into web research at github.com/trending', () => {
    expect(matchPlaybook('lakukan analisa ke github trending untuk hari ini')).toEqual({
      id: 'web_research', tool: 'playbook.web_research',
      args: { goal: 'lakukan analisa ke github trending untuk hari ini', url: 'https://github.com/trending' },
    })
  })

  it.each([
    ['analyse GitHub trending today', 'web_research'],
    ['riset harga VPS murah di Indonesia', 'web_research'],
    ['bandingkan bun dan deno untuk server', 'web_research'],
    ['compare react flow and xyflow licensing', 'web_research'],
    ['research https://example.com/pricing', 'web_research'],
    ['perbaiki bug login redirect', 'code_change'],
    ['implement dark mode toggle', 'code_change'],
    ['tolong tambahkan test untuk parser', 'code_change'],
    ['refactor the settings store', 'code_change'],
    ['review PR #42', 'review'],
    ['periksa diff branch feature/x', 'review'],
  ])('%s -> %s', (text, id) => {
    expect(matchPlaybook(text)?.id).toBe(id)
  })

  it.each(['halo, apa kabar?', 'thanks!', 'how are you today', 'ok sip', 'good morning'])('chit-chat "%s" matches nothing', (text) => {
    expect(matchPlaybook(text)).toBeNull()
    expect(playbookHintLine(text, () => true)).toBe('')
  })

  it('review targets the URL when one is named, and the hint line carries JSON args', () => {
    expect(matchPlaybook('review https://github.com/a/b/pull/7')?.args).toEqual({ target: 'https://github.com/a/b/pull/7' })
    expect(playbookHintLine('research https://bun.sh.', () => true)).toBe('Suggested playbook: playbook.web_research {"goal":"research https://bun.sh.","url":"https://bun.sh"} For ONE page or ONE search, browser_read fits better than a worker.')
  })
})

describe('playbookHintLine for a lone link', () => {
  const noRead = (tool: string) => tool !== 'browser_read'
  it('suggests browser_read, not a playbook', () => {
    expect(matchPlaybook('look at https://example.com/pricing')).toBeNull()
    const line = playbookHintLine('look at https://example.com/pricing', () => true)
    expect(line).toBe('Suggested tool: browser_read {"url":"https://example.com/pricing"}')
    expect(line).not.toContain('playbook')
  })
  it('keeps the playbook for research words and adds the browser_read note only when that tool is usable', () => {
    const line = playbookHintLine('bandingkan https://a.dev dan https://b.dev', () => true)
    expect(line).toContain('Suggested playbook: playbook.web_research')
    expect(line).toContain('browser_read fits better')
    expect(playbookHintLine('research https://bun.sh', noRead)).not.toContain('browser_read')
  })
  it('stays silent without a link or keyword, and never suggests browser_read when it is unavailable', () => {
    expect(playbookHintLine('tolong rapikan catatan ini', () => true)).toBe('')
    expect(playbookHintLine('look at https://example.com', noRead)).toBe('')
  })
  it('leaves code_change and review matching untouched', () => {
    expect(playbookHintLine('review https://github.com/a/b/pull/7', () => true)).toBe('Suggested playbook: playbook.review {"target":"https://github.com/a/b/pull/7"}')
    expect(matchPlaybook('fix bug at https://x.dev/y')?.id).toBe('code_change')
  })
})

describe('skill requests (no playbook)', () => {
  it.each(['buatkan skill untuk ringkas status', 'create a new skill for release notes', 'ubah skill webterm-project-status', 'write a skill that triages PRs'])('"%s" matches no playbook and gets no hint', (text) => {
    expect(matchPlaybook(text)).toBeNull()
    expect(playbookHintLine(text, () => true)).toBe('')
  })
  it('keeps the lone-link browser_read precedence and is silent when the tool is missing', () => {
    expect(playbookHintLine('look at https://example.com/pricing', () => true)).toBe('Suggested tool: browser_read {"url":"https://example.com/pricing"}')
    expect(playbookHintLine('buat skill baru', () => false)).toBe('')
  })
  it('the capability map points a Central skill request at skill.propose, not at a worker', () => {
    const map = renderCapabilityMap([{ name: 'skill.propose', access: 'auto' }, { name: 'task.create', access: 'auto' }, { name: 'agent.spawn', access: 'asks' }])
    expect(map).toContain('create or edit a Central skill: skill.propose (auto)')
    expect(map).not.toContain('skill_authoring')
  })
})

describe('playbookHintLine when the playbook tool is missing', () => {
  it('says workers are off instead of suggesting a tool Central cannot call', () => {
    const asked: string[] = []
    const line = playbookHintLine('lakukan analisa ke github trending untuk hari ini', (tool) => { asked.push(tool); return false })
    expect(asked).toEqual(['playbook.web_research'])
    expect(line).toBe('This looks like web research, but workers are off (Settings › Central › What Central may do)')
    expect(playbookHintLine('review PR #3', () => false)).toBe('This looks like a review, but workers are off (Settings › Central › What Central may do)')
  })
})

describe('renderCapabilityMap', () => {
  it('maps goals to tools with access; a playbook asks when its spawn step asks; unknown tools are left out', () => {
    const map = renderCapabilityMap([
      { name: 'playbook.web_research', access: 'auto' }, { name: 'playbook.review', access: 'auto' },
      { name: 'task.create', access: 'auto' }, { name: 'agent.spawn', access: 'asks' }, { name: 'agent.prompt', access: 'auto' },
      { name: 'health.scan', access: 'off' },
    ])
    expect(map).toBe('Capabilities: research the web: playbook.web_research (asks) · review: playbook.review (asks) · '
      + 'delegate by hand: task.create (auto), agent.spawn (asks), agent.prompt (auto) · '
      + 'reach a Claude session outside the canvas: task.create (auto), agent.spawn (asks) · project health: health.scan (off)')
  })

  it('puts reading one page (browser_read) before research the web', () => {
    const map = renderCapabilityMap([{ name: 'playbook.web_research', access: 'auto' }, { name: 'browser_read', access: 'auto' }, { name: 'task.create', access: 'auto' }, { name: 'agent.spawn', access: 'auto' }])
    expect(map.indexOf('read one web page: browser_read (auto)')).toBeGreaterThan(-1)
    expect(map.indexOf('read one web page')).toBeLessThan(map.indexOf('research the web'))
  })

  it('names reminders for what is not delegated, and an optional step (browser_open) never turns a playbook off', () => {
    const map = renderCapabilityMap([{ name: 'playbook.web_research', access: 'auto' }, { name: 'task.create', access: 'auto' }, { name: 'agent.spawn', access: 'auto' }, { name: 'reminder.set', access: 'auto' }])
    expect(map).toContain('research the web: playbook.web_research (auto)')
    expect(map).toContain('follow up later (not delegated work): reminder.set (auto)')
    expect(map).not.toContain('check later')
  })

  it('lists reaching an outside Claude session via spawn, and drops it when both tools are unregistered', () => {
    const on = renderCapabilityMap([{ name: 'task.create', access: 'auto' }, { name: 'agent.spawn', access: 'asks' }])
    expect(on).toContain('reach a Claude session outside the canvas: task.create (auto), agent.spawn (asks)')
    expect(renderCapabilityMap([{ name: 'health.scan', access: 'auto' }])).not.toContain('outside the canvas')
  })

  it('is empty without tools', () => {
    expect(renderCapabilityMap([])).toBe('')
  })
})
