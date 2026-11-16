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
    ['look at https://example.com/pricing', 'web_research'],
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
    expect(playbookHintLine('research https://bun.sh.', () => true)).toBe('Suggested playbook: playbook.web_research {"goal":"research https://bun.sh.","url":"https://bun.sh"}')
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
