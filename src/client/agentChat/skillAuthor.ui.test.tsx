/** @vitest-environment jsdom */
// Skill-author chat UI: locked-role header, guiding placeholder, empty state with click-to-fill starters, and the
// "draft proposed" card that opens the Skills tab. Display only: nothing is sent until the user presses Send.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fakeAgentChatTransport } from './agentChatTransport.fake'
import { AgentChatView } from './agentChatView'
import { SKILL_AUTHOR_EMPTY, SKILL_AUTHOR_HEADER, SKILL_AUTHOR_LOCK_REASON, SKILL_AUTHOR_PLACEHOLDER } from './skillAuthor.preset'
import { proposedDraft } from './SkillAuthorChat'
import { openCentralTab } from '../secondarySideBar.store'
import type { AgentChatEvent } from '../../shared/agentChat.wire'

vi.mock('../secondarySideBar.store', async (orig) => ({ ...(await orig<typeof import('../secondarySideBar.store')>()), openCentralTab: vi.fn() }))

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.scrollIntoView ??= () => undefined
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

function mount(preset?: 'skill-author') {
  const f = fakeAgentChatTransport()
  const header = document.body.appendChild(document.createElement('div'))
  render(<AgentChatView nodeId="n1" onNodeData={vi.fn()} transport={f.t} headerHost={header} {...(preset ? { preset } : {})} />)
  f.emit()
  return f
}
const composer = () => document.querySelector('textarea') as HTMLTextAreaElement
const tool = (seq: number, state: 'done' | 'error', command: string): AgentChatEvent => ({ t: 'tool', seq, id: `tu${seq}`, name: 'Bash', input: { command }, state })

describe('skill-author chat', () => {
  it('header: lock icon, compact role line, reachable for the tooltip that gives the reason', () => {
    mount('skill-author')
    const note = screen.getByRole('note', { name: 'Chat role' })
    expect(note.textContent).toContain(SKILL_AUTHOR_HEADER)
    expect(note.querySelector('.codicon-lock')).toBeTruthy()
    expect(note.querySelector('[tabindex="0"]')).toBeTruthy()
    expect(SKILL_AUTHOR_LOCK_REASON).toMatch(/only run `webterm skills`/)
  })

  it('the composer guides: placeholder describes the procedure to turn into a skill', () => {
    mount('skill-author')
    expect(composer().placeholder).toBe(SKILL_AUTHOR_PLACEHOLDER)
    cleanup()
    mount()
    expect(composer().placeholder).not.toBe(SKILL_AUTHOR_PLACEHOLDER)
  })

  it('empty state offers three starters; a click fills the composer without sending', async () => {
    const { t } = mount('skill-author')
    const starters = within(await screen.findByRole('list', { name: 'Starters' })).getAllByRole('button')
    expect(starters.map((b) => b.textContent)).toEqual([...SKILL_AUTHOR_EMPTY.examples])
    fireEvent.click(starters[1])
    expect(composer().value).toBe(SKILL_AUTHOR_EMPTY.examples[1])
    expect(t.send).not.toHaveBeenCalled()
  })

  it('a plain chat has no starters and no draft card', () => {
    mount()
    expect(screen.queryByRole('list', { name: 'Starters' })).toBeNull()
    expect(screen.queryByText(/Draft proposed/)).toBeNull()
  })

  it('a finished propose shows the draft card; its button opens the Skills tab; a failed one shows nothing', async () => {
    const f = mount('skill-author')
    f.emit(tool(1, 'error', 'webterm skills propose --name webterm-x'))
    await new Promise((r) => setTimeout(r, 20)) // events are applied in a batched tick
    expect(screen.queryByText('Draft proposed - review in Control > Skills')).toBeNull()
    f.emit(tool(2, 'done', 'webterm skills propose --name webterm-x --description "d" --body-file - <<\'EOF\''))
    expect(await screen.findByText('Draft proposed - review in Control > Skills')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open Skills tab' }))
    expect(openCentralTab).toHaveBeenCalledWith('skills')
  })

  it('proposedDraft ignores other commands and other tools', () => {
    const t = (name: string, command: string, state = 'done') => ({ id: 'a', name, input: { command }, state }) as never
    expect(proposedDraft({ tools: { a: t('Bash', 'webterm skills list') } })).toBe(false)
    expect(proposedDraft({ tools: { a: t('Read', 'webterm skills propose') } })).toBe(false)
    expect(proposedDraft({ tools: { a: t('Bash', 'webterm skills edit --name x') } })).toBe(true)
  })
})
