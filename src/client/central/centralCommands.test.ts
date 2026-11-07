import { describe, expect, it, vi } from 'vitest'
import type { CompletionItem, CompletionTrigger } from '../agentChat/composerCompletion'
import { CENTRAL_COMMANDS, CENTRAL_LIST_REUSE_MS, centralCommandList, createCentralCommands, resolveCentralInput } from './centralCommands'

const slash = (query: string): CompletionTrigger => ({ kind: 'slash', query, start: 0, end: query.length + 1 })
const at = (query: string): CompletionTrigger => ({ kind: 'file', query, start: 0, end: query.length + 1 })
const names = (items: CompletionItem[]): string[] => items.map((i) => i.value)
const SKILL = { name: 'webterm-demo', description: 'Summarize status' }
const ALL = centralCommandList(true, [SKILL])

describe('resolveCentralInput', () => {
  it('chat actions and panel shortcuts act instead of sending', () => {
    expect(resolveCentralInput('/new', ALL)).toEqual({ kind: 'chat', action: 'new' })
    expect(resolveCentralInput('  /CLEAR', ALL)).toEqual({ kind: 'chat', action: 'new' })
    expect(resolveCentralInput('/history', ALL)).toEqual({ kind: 'chat', action: 'history' })
    expect(resolveCentralInput('/help', ALL)).toEqual({ kind: 'chat', action: 'help' })
    expect(resolveCentralInput('/approvals', ALL)).toEqual({ kind: 'panel', tab: 'approvals' })
    expect(resolveCentralInput('/status', ALL)).toEqual({ kind: 'panel', tab: 'control' })
    expect(resolveCentralInput('/memory', ALL)).toEqual({ kind: 'panel', tab: 'memory' })
    expect(resolveCentralInput('/halt', ALL)).toEqual({ kind: 'panel', tab: 'control', halt: true })
  })

  it('prompt shortcuts expand into an English request; arguments are required where hinted', () => {
    expect(resolveCentralInput('/projects', ALL)).toEqual({ kind: 'send', text: 'List my projects with their status.' })
    expect(resolveCentralInput('/nodes webterm.', ALL)).toEqual({ kind: 'send', text: 'List the nodes in project webterm.' })
    expect(resolveCentralInput('/tasks webterm', ALL)).toEqual({ kind: 'send', text: 'Show the task status of project webterm.' })
    expect(resolveCentralInput('/plan ship the release\nwith notes', ALL)).toEqual({ kind: 'send', text: 'Propose a plan for: ship the release\nwith notes' })
    expect(resolveCentralInput('/nodes   ', ALL)).toEqual({ kind: 'usage', message: 'Usage: /nodes <project>', draft: '/nodes ' })
  })

  it('a skill expands into a request to use it; unknown commands and plain text are sent as typed', () => {
    expect(resolveCentralInput('/webterm-demo for today', ALL)).toEqual({ kind: 'send', text: 'Use the "webterm-demo" skill. for today' })
    expect(resolveCentralInput('/webterm-demo', ALL)).toEqual({ kind: 'send', text: 'Use the "webterm-demo" skill.' })
    expect(resolveCentralInput('/compact', ALL)).toEqual({ kind: 'send', text: '/compact' })
    expect(resolveCentralInput('see /new', ALL)).toEqual({ kind: 'send', text: 'see /new' })
    expect(resolveCentralInput('/newer', ALL)).toEqual({ kind: 'send', text: '/newer' })
  })

  it('panel shortcuts only exist while the Central panel is on', () => {
    const off = centralCommandList(false)
    expect(off.map((c) => c.name)).toEqual(['new', 'clear', 'history', 'help', 'projects', 'nodes', 'tasks', 'plan'])
    expect(resolveCentralInput('/approvals', off)).toEqual({ kind: 'send', text: '/approvals' })
  })

  it('a skill never shadows a command of the table', () => {
    const list = centralCommandList(true, [{ name: 'new', description: 'evil' }])
    expect(list.filter((c) => c.name === 'new')).toHaveLength(1)
    expect(resolveCentralInput('/new', list)).toEqual({ kind: 'chat', action: 'new' })
  })

  it('every command has a description; argument commands have a hint', () => {
    for (const c of CENTRAL_COMMANDS) expect(c.description.length).toBeGreaterThan(5)
    expect(CENTRAL_COMMANDS.filter((c) => c.argumentHint).map((c) => c.name)).toEqual(['nodes', 'tasks', 'plan'])
  })
})

describe('createCentralCommands completion', () => {
  it('"/" lists the commands with description, hint and badge; prefix matches rank first', async () => {
    const c = createCentralCommands({ centralEnabled: true, loadSkills: async () => [] })
    const all = await c.completion.provider(slash(''))
    expect(names(all)).toContain('approvals')
    expect(all.find((i) => i.value === 'nodes')).toMatchObject({ description: 'Ask Central for the nodes of a project', argumentHint: '<project>', badge: 'ask' })
    expect(all.find((i) => i.value === 'halt')?.badge).toBe('panel')
    expect(names(await c.completion.provider(slash('app')))).toEqual(['approvals'])
    expect(names(await c.completion.provider(slash('his')))[0]).toBe('history')
    // A name prefix ranks above a name containing it (approvals) and above description-only matches.
    const pro = names(await c.completion.provider(slash('pro')))
    expect(pro[0]).toBe('projects')
    expect(pro.indexOf('approvals')).toBeLessThan(pro.indexOf('nodes'))
    expect(names(await c.completion.provider(slash('zzz')))).toEqual([])
  })

  it('lists approved skills while skills are on, none when the route fails (503 skills_off)', async () => {
    const on = createCentralCommands({ centralEnabled: true, loadSkills: async () => [SKILL] })
    expect((await on.completion.provider(slash('webt'))).at(0)).toMatchObject({ value: 'webterm-demo', description: 'Summarize status', badge: 'skill' })
    expect(on.resolve('/webterm-demo')).toEqual({ kind: 'send', text: 'Use the "webterm-demo" skill.' })

    const off = createCentralCommands({ centralEnabled: true, loadSkills: () => Promise.reject(new Error('skills_off')) })
    expect(names(await off.completion.provider(slash('')))).not.toContain('webterm-demo')
    expect(off.resolve('/webterm-demo')).toEqual({ kind: 'send', text: '/webterm-demo' })
  })

  it('does not ask for skills while the Central panel is off', async () => {
    const loadSkills = vi.fn(async () => [SKILL])
    const c = createCentralCommands({ centralEnabled: false, loadSkills })
    const items = names(await c.completion.provider(slash('')))
    expect(items).not.toContain('approvals')
    expect(items).not.toContain('webterm-demo')
    expect(loadSkills).not.toHaveBeenCalled()
  })

  it('reuses a loaded skill list, and asks again after the reuse window', async () => {
    let t = 0
    const loadSkills = vi.fn(async () => [SKILL])
    const c = createCentralCommands({ centralEnabled: true, loadSkills, now: () => t })
    await c.completion.provider(slash(''))
    await c.completion.provider(slash('n'))
    expect(loadSkills).toHaveBeenCalledTimes(1)
    t = CENTRAL_LIST_REUSE_MS + 1
    await c.completion.provider(slash(''))
    expect(loadSkills).toHaveBeenCalledTimes(2)
  })

  it('"@" lists project names, fuzzy-ranked, with Central wording', async () => {
    const c = createCentralCommands({ centralEnabled: true, loadProjects: async () => ['webterm', 'nodeterm', 'Billing API'] })
    expect(names(await c.completion.provider(at('')))).toEqual(['webterm', 'nodeterm', 'Billing API'])
    expect(names(await c.completion.provider(at('bil')))).toEqual(['Billing API'])
    expect((await c.completion.provider(at('web')))[0]?.badge).toBe('project')
    expect(c.completion.text?.file).toEqual({ label: 'Projects', empty: 'No matching projects', loading: 'Loading projects…' })
  })
})
