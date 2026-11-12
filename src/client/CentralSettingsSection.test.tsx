/** @vitest-environment jsdom */
// Settings › Central: the registry renders the few real preferences, each control writes through its own
// API (capabilities toggle/sub, /api/settings/env PUT), Central off disables all but the master switch,
// Advanced starts closed, and the rows that became automatic are gone.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CAPABILITIES, CAPABILITY_IDS, type CapabilitiesResponse, type CapabilityId, type CapabilityView } from '../shared/featureCapabilities'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { CENTRAL_ENV_KEYS, CENTRAL_FIELDS, CENTRAL_GROUPS } from './centralSettings.registry'
import { levelOf, levelToggle } from './CentralSettingsSection'
import { COST_CAP_KEY, dollarsToMicros } from './SettingsCostLimit'
import { SettingsPanel, toSectionId } from './SettingsPanel'
import { resetCapabilitiesCache } from './useCapabilities'

// test-only fixtures
const SUBS: Partial<Record<CapabilityId, { key: string; label: string; on: boolean }[]>> = {
  central: [{ key: 'centralSkills', label: 's', on: false }, { key: 'centralSkillPropose', label: 'p', on: false }, { key: 'centralCheckpoint', label: 'c', on: true }],
  workers: [{ key: 'runRequireApproval', label: 'a', on: true }],
  browser: [{ key: 'browserAgent', label: 'b', on: true }],
}
const DEFAULTS: Record<string, string> = {
  WEBTERM_CENTRAL_DAILY_SPAWNS: '20', WEBTERM_CENTRAL_TURN_WALL_MS: '120000', WEBTERM_CENTRAL_TURN_STEPS: '12',
  WEBTERM_CENTRAL_CONTEXT_WINDOW: '128000', WEBTERM_CENTRAL_DAILY_TOKENS: '10000000', WEBTERM_CENTRAL_MAX_INFLIGHT: '3',
  WEBTERM_CENTRAL_MODEL: '', WEBTERM_KNOWLEDGE: 'off', WEBTERM_CENTRAL_RELIABILITY: 'off', WEBTERM_AGENT_MAIL: 'off', [COST_CAP_KEY]: '5000000',
}
let on: Set<CapabilityId>
let posts: { url: string; body: unknown }[]
let puts: unknown[]
let envFails: boolean
let putFails: boolean

const view = (id: CapabilityId): CapabilityView => ({
  id, title: CAPABILITIES[id].title, blurb: CAPABILITIES[id].blurb, status: on.has(id) ? 'on' : 'off',
  ...(on.has(id) && SUBS[id] ? { subs: SUBS[id] } : {}),
  ...(id === 'telegram' && on.has(id) ? { detail: 'Connected as @bot' } : {}),
})
const caps = (): CapabilitiesResponse => ({
  capabilities: CAPABILITY_IDS.map(view),
  advanced: { agentEngine: { value: 'auto', detected: 'claude' }, chromiumPath: { value: '', detected: false, active: null, source: null, overrideInvalid: false, candidates: [] }, dataDir: '/tmp/d' },
})
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  on = new Set(['central', 'workers', 'browser', 'telegram'])
  posts = []
  puts = []
  envFails = false
  putFails = false
  resetCapabilitiesCache()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    if (url.startsWith('/api/capabilities')) {
      if (method === 'POST') posts.push({ url, body })
      return json(caps())
    }
    if (url === '/api/settings/env' && method === 'PUT') {
      if (putFails) return json({ error: 'nope' }, 500)
      puts.push(body)
      return json({ entries: [] })
    }
    if (url === '/api/settings/env') {
      if (envFails) return json({ error: 'down' }, 500)
      return json({ locked: false, entries: Object.entries(DEFAULTS).map(([key, v]) => ({ key, value: key === COST_CAP_KEY ? v : '', effective: v, default: v, editable: true })) })
    }
    if (url === '/api/central/checkin-settings') return json({ enabled: false, dailyLimit: 10, usedToday: 0 })
    return json({ items: [] })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function open(onChange = vi.fn()): Promise<HTMLElement> {
  render(<SettingsPanel settings={DEFAULT_SETTINGS} onChange={onChange} onClose={vi.fn()} initialSection="central" />)
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Central Agent' }).hasAttribute('disabled')).toBe(false))
  await waitFor(() => expect(screen.getByLabelText('Workers per day').textContent).toBe('20 workers'))
  return screen.getByRole('main', { name: 'Settings' })
}

describe('registry', () => {
  it('every field has a known group, and every env key is read once', () => {
    expect(CENTRAL_FIELDS.every((f) => CENTRAL_GROUPS.includes(f.group))).toBe(true)
    expect(new Set(CENTRAL_FIELDS.map((f) => f.id)).size).toBe(CENTRAL_FIELDS.length)
    expect(CENTRAL_ENV_KEYS).toContain('WEBTERM_CENTRAL_DAILY_SPAWNS')
    expect(CENTRAL_ENV_KEYS).not.toContain('WEBTERM_CENTRAL_TURN_TOKENS')
  })

  it('level segmented maps to exactly one capability toggle', () => {
    const level = CENTRAL_FIELDS.find((f) => f.id === 'level')!
    const v = (set: CapabilityId[]) => (id: CapabilityId) => ({ status: set.includes(id) ? 'on' : 'off' }) as CapabilityView
    expect(levelOf(level, v(['central']))).toBe('none')
    expect(levelOf(level, v(['central', 'workers']))).toBe('workers')
    expect(levelOf(level, v(['central', 'workers', 'autonomy']))).toBe('autonomy')
    expect(levelToggle(level, 'workers', v(['central']))).toEqual({ id: 'workers', on: true })
    expect(levelToggle(level, 'autonomy', v(['central']))).toEqual({ id: 'autonomy', on: true })
    expect(levelToggle(level, 'none', v(['central', 'workers', 'autonomy']))).toEqual({ id: 'workers', on: false })
    expect(levelToggle(level, 'workers', v(['central', 'workers', 'autonomy']))).toEqual({ id: 'autonomy', on: false })
    expect(levelToggle(level, 'workers', v(['central', 'workers']))).toBeNull()
  })
})

describe('Settings › Central Agent', () => {
  it('deep link lands on the section and renders every group; Advanced starts closed', async () => {
    const main = await open()
    expect(toSectionId('central')).toBe('central')
    expect(within(main).getByRole('heading', { level: 2 }).textContent).toBe('Central')
    expect([...main.querySelectorAll('[data-central-group]')].map((g) => g.getAttribute('data-central-group'))).toEqual([...CENTRAL_GROUPS])
    const advanced = main.querySelector('details[data-central-group="advanced"]') as HTMLDetailsElement
    expect(advanced.open).toBe(false)
    expect([...advanced.querySelectorAll('[data-central-field]')].map((x) => x.getAttribute('data-central-field'))).toEqual(['dailySpawns', 'checkinLimit', 'maxInflight'])
  })

  it('automatic rows are gone: model, context window, reply limits, token budget, skills, engine, browser, telegram, links, experiments', async () => {
    const main = await open()
    expect(CENTRAL_FIELDS.map((f) => f.id)).toEqual(['central', 'level', 'checkin', 'costLimit', 'dailySpawns', 'checkinLimit', 'maxInflight'])
    for (const gone of ['Model', 'Context window', 'Reply time limit', 'Steps per reply', 'Daily token budget', 'Use approved skills', 'Suggest new skills',
      'Summarize long conversations', 'Engine', 'Claude profile', 'Project knowledge', 'Steadier autonomy', 'Agent mail', 'Ask before each worker runs']) {
      expect(within(main).queryByLabelText(gone), gone).toBeNull()
    }
    expect(within(main).queryAllByRole('button', { name: /^Open / })).toEqual([])
    expect(CENTRAL_ENV_KEYS).toEqual(['WEBTERM_CENTRAL_DAILY_COST_MICROS', 'WEBTERM_CENTRAL_DAILY_SPAWNS', 'WEBTERM_CENTRAL_MAX_INFLIGHT'])
  })

  it('master switch toggles the central capability', async () => {
    await open()
    fireEvent.click(screen.getByRole('switch', { name: 'Central Agent' }))
    await waitFor(() => expect(posts).toEqual([{ url: '/api/capabilities/central', body: { enabled: false } }]))
  })

  it('"What Central may do" writes the matching capability; Work on its own asks first', async () => {
    await open()
    const group = screen.getByRole('radiogroup', { name: 'What Central may do' })
    expect(within(group).getByRole('radio', { name: 'Propose work (asks first)' }).getAttribute('aria-checked')).toBe('true')
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    fireEvent.click(within(group).getByRole('radio', { name: 'Work on its own' }))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(posts).toEqual([])
    confirm.mockReturnValue(true)
    fireEvent.click(within(group).getByRole('radio', { name: 'Work on its own' }))
    await waitFor(() => expect(posts).toEqual([{ url: '/api/capabilities/autonomy', body: { enabled: true } }]))
    fireEvent.click(within(group).getByRole('radio', { name: 'Chat only' }))
    await waitFor(() => expect(posts[1]).toEqual({ url: '/api/capabilities/workers', body: { enabled: false } }))
  })

  it('Propose work always asks: moving there also turns the worker approval on', async () => {
    on = new Set(['central'])
    await open()
    const group = screen.getByRole('radiogroup', { name: 'What Central may do' })
    fireEvent.click(within(group).getByRole('radio', { name: 'Propose work (asks first)' }))
    await waitFor(() => expect(posts).toEqual([
      { url: '/api/capabilities/workers', body: { enabled: true } },
      { url: '/api/capabilities/workers/sub', body: { key: 'runRequireApproval', on: true } },
    ]))
  })

  it('Workers per day writes through /api/settings/env in stored units', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Increase Workers per day' }))
    await waitFor(() => expect(puts).toEqual([{ set: { WEBTERM_CENTRAL_DAILY_SPAWNS: '25' }, unset: [] }]))
    await waitFor(() => expect(screen.getByLabelText('Workers per day').textContent).toBe('25 workers'))
  })

  it('Max workers at once (Advanced) writes through /api/settings/env once Central works on its own', async () => {
    on = new Set(['central', 'workers', 'autonomy'])
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Decrease Max workers at once' }))
    await waitFor(() => expect(puts).toEqual([{ set: { WEBTERM_CENTRAL_MAX_INFLIGHT: '2' }, unset: [] }]))
  })

  it('a pick shows at once; a failed write reverts it and shows the error at that field with Retry', async () => {
    await open()
    putFails = true
    const field = (): HTMLElement => screen.getByLabelText('Workers per day').closest('[data-slot="settings-field"]') as HTMLElement
    fireEvent.click(screen.getByRole('button', { name: 'Increase Workers per day' }))
    expect(screen.getByLabelText('Workers per day').textContent).toBe('25 workers') // pending, before the server answers
    const alert = await within(field()).findByRole('alert')
    expect(alert.textContent).toContain('Could not save')
    expect(screen.getByLabelText('Workers per day').textContent).toBe('20 workers')
    putFails = false
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(field().querySelector('[data-save]')?.textContent).toContain('Saved'))
    expect(field().querySelector('[data-save]')?.getAttribute('role')).toBe('status')
    expect(puts).toEqual([{ set: { WEBTERM_CENTRAL_DAILY_SPAWNS: '25' }, unset: [] }])
  })

  it('env-backed fields show the modified dot and a visible Reset only when they differ from the default', async () => {
    await open()
    const field = (): HTMLElement => screen.getByLabelText('Workers per day').closest('[data-slot="settings-field"]') as HTMLElement
    expect(within(field()).queryByText('(Modified)')).toBeNull()
    expect(within(field()).queryByRole('button', { name: /^Reset Setting/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Increase Workers per day' }))
    await waitFor(() => expect(within(field()).getByText('(Modified)')).toBeTruthy())
    fireEvent.click(within(field()).getByRole('button', { name: 'Reset Setting: Workers per day' }))
    await waitFor(() => expect(puts[1]).toEqual({ set: {}, unset: ['WEBTERM_CENTRAL_DAILY_SPAWNS'] }))
    await waitFor(() => expect(screen.getByLabelText('Workers per day').textContent).toBe('20 workers'))
    expect(within(field()).queryByText('(Modified)')).toBeNull()
  })

  it('the page title is not repeated as a prefix on its own field', async () => {
    await open()
    const master = screen.getByRole('switch', { name: 'Central Agent' }).closest('[data-slot="settings-field"]') as HTMLElement
    expect(master.querySelector('.st-category')).toBeNull()
  })

  it('env load failure offers Retry', async () => {
    envFails = true
    render(<SettingsPanel settings={DEFAULT_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} initialSection="central" />)
    const alerts = await screen.findAllByRole('alert')
    expect(alerts.some((a) => a.textContent?.includes('Could not load these settings'))).toBe(true)
    envFails = false
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]!)
    await waitFor(() => expect(screen.getByLabelText('Workers per day').textContent).toBe('20 workers'))
  })

  it('Central off: every control but the master switch is disabled, with a reason', async () => {
    on = new Set()
    render(<SettingsPanel settings={DEFAULT_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} initialSection="central" />)
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Central Agent' }).hasAttribute('disabled')).toBe(false))
    const main = screen.getByRole('main', { name: 'Settings' })
    const switches = within(main).getAllByRole('switch', { hidden: true })
    expect(switches.filter((s) => !s.hasAttribute('disabled')).map((s) => s.id)).toEqual(['st-central-central'])
    expect(within(main).getAllByRole('radio', { hidden: true }).every((r) => r.hasAttribute('disabled'))).toBe(true)
    expect(screen.getByRole('button', { name: 'Increase Workers per day' }).hasAttribute('disabled')).toBe(true)
    await waitFor(() => expect((screen.getByLabelText('Daily spending limit') as HTMLInputElement).disabled).toBe(true))
    expect(main.querySelectorAll('[data-reason]').length).toBeGreaterThan(3)
    expect(main.textContent).toContain('Turn on Central Agent first.')
    // Each disabled switch points at the line saying why.
    for (const sw of switches.filter((x) => x.hasAttribute('disabled'))) {
      expect(document.getElementById(sw.getAttribute('aria-describedby') ?? '')?.hasAttribute('data-reason')).toBe(true)
    }
  })

  it('daily spending limit shows dollars, writes micros, and clears to unlimited', async () => {
    await open()
    const input = screen.getByLabelText('Daily spending limit') as HTMLInputElement
    await waitFor(() => expect(input.value).toBe('5'))
    fireEvent.change(input, { target: { value: '2.5' } })
    fireEvent.blur(input)
    await waitFor(() => expect(puts).toEqual([{ set: { [COST_CAP_KEY]: '2500000' }, unset: [] }]))
    // The field is locked while saving and shows the saved amount after; type only once it is back.
    await waitFor(() => expect(input.disabled).toBe(false))
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(puts[1]).toEqual({ set: {}, unset: [COST_CAP_KEY] }))
    expect(dollarsToMicros('1.234567')).toBe(1_234_567)
    expect(dollarsToMicros('abc')).toBeUndefined()
  })
})
