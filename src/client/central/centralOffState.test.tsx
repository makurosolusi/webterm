/** @vitest-environment jsdom */
// A Central tab whose feature is off (503 skills_off / agents_off) shows what it does and a switch, never the raw
// "GET ... failed (404 ...)" line; a genuine failure still shows as an error, in human words.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InboxApiError } from '../inboxTypes'
import { resetCapabilitiesCache } from '../useCapabilities'
import AgentList from './AgentList'
import SkillReview from './SkillReview'
import { CL } from './centralLabels'
import { fakeClient } from './centralFixtures.testutil'

const advanced = { chromiumPath: { value: '', detected: true, active: null, source: null, overrideInvalid: false, candidates: [] }, agentEngine: { value: 'auto', detected: 'claude' } } // test-only
const caps = (workers: string) => new Response(JSON.stringify({
  capabilities: [
    { id: 'central', title: 'Central Agent', blurb: 'Assistant.', status: 'on' },
    { id: 'workers', title: 'Worker orchestrator', blurb: 'Let agents run commands on this computer.', status: workers },
  ],
  advanced,
}))
const offError = (code: string) => new InboxApiError(`GET /api/central/x failed (503 ${code})`, 503, code)

beforeEach(resetCapabilitiesCache)
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Skills tab off state', () => {
  it('explains skills and turns them on through the Central capability switch, then reloads', async () => {
    const f = vi.fn().mockResolvedValueOnce(caps('on')).mockResolvedValueOnce(caps('on'))
    vi.stubGlobal('fetch', f)
    const listSkills = vi.fn().mockRejectedValueOnce(offError('skills_off')).mockResolvedValue([])
    render(<SkillReview client={fakeClient({ listSkills })} />)
    expect(await screen.findByText(CL.skillsOff)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: CL.turnOn }))
    await waitFor(() => expect(listSkills).toHaveBeenCalledTimes(2))
    const sub = f.mock.calls.find((c) => c[0] === '/api/capabilities/central/sub')
    expect(JSON.parse(String((sub?.[1] as RequestInit).body))).toEqual({ key: 'centralSkills', on: true })
    expect(await screen.findByText(CL.empty)).toBeTruthy()
    expect(screen.queryByText(CL.skillsOff)).toBeNull()
  })

  it('a genuine failure is an error with a human message, not the raw request line', async () => {
    const listSkills = vi.fn().mockRejectedValue(new InboxApiError('GET /api/central/skills failed (404 unknown route)', 404, 'unknown route'))
    render(<SkillReview client={fakeClient({ listSkills })} />)
    expect((await screen.findByRole('alert')).textContent).toBe(CL.loadFailed)
    expect(screen.queryByText(/failed \(404/)).toBeNull()
    expect(screen.queryByText(CL.skillsOff)).toBeNull()
  })
})

describe('Agents tab off state', () => {
  it('explains agents and offers the worker orchestrator; turning it on reloads the list', async () => {
    const f = vi.fn().mockResolvedValueOnce(caps('off')).mockResolvedValueOnce(caps('on'))
    vi.stubGlobal('fetch', f)
    const listAgents = vi.fn().mockRejectedValueOnce(offError('agents_off')).mockResolvedValue([])
    render(<AgentList client={fakeClient({ listAgents })} />)
    expect(await screen.findByText(CL.agentsOff)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on' }))
    await waitFor(() => expect(listAgents).toHaveBeenCalledTimes(2))
    expect(f.mock.calls[1][0]).toBe('/api/capabilities/workers')
    expect(await screen.findByText(CL.empty)).toBeTruthy()
  })
})
