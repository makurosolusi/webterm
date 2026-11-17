/** @vitest-environment jsdom */
// Find in the Agent Chat node: the header Search button used to be a no-op (AgentChatNode passed
// `onToggleSearch={() => undefined}`); these tests lock that it opens a working find bar over the transcript.
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createElement, forwardRef } from 'react'
import { ReactFlow, type Node } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../vscode/test-setup'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { SettingsProvider } from '../useSettings'
import AgentChatNode from '../AgentChatNode'

// A stub transcript: two matches for "alpha" in one message, one in the next, one inside a closed <details>.
vi.mock('./agentChatView', () => ({
  AgentChatView: () => (
    <div className="chat-thread agent-chat-thread" role="log">
      <p>Alpha beta alpha</p>
      <p>gamma ALPHA</p>
      <details><summary>Thinking</summary><p>hidden alpha</p></details>
    </div>
  ),
}))

// Under vitest `@lit/react` resolves to its server build, which never attaches the `onInput` listener; a plain
// custom element lets React 19 wire it, so typing can be driven here. Production uses the real wrapper.
vi.mock('@/vscode/register', async (orig) => ({
  ...(await orig<typeof import('@/vscode/register')>()),
  Textfield: forwardRef<HTMLElement, Record<string, unknown>>(({ className, ...p }, ref) => createElement('vscode-textfield', { ...p, class: className, ref })),
}))

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
g.IS_REACT_ACT_ENVIRONMENT = true

type Fake = { ranges: Range[] }
const registry = new Map<string, Fake>()
const scrolled = vi.fn()
beforeEach(() => {
  registry.clear()
  scrolled.mockClear()
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  Element.prototype.scrollIntoView = scrolled
  ;(globalThis as { Highlight?: unknown }).Highlight = class { ranges: Range[]; constructor(...r: Range[]) { this.ranges = r } }
  ;(globalThis as { CSS?: unknown }).CSS = { highlights: registry }
})
afterEach(cleanup)

const node: Node = { id: 'c1', type: 'agentChat', position: { x: 0, y: 0 }, width: 400, height: 400, data: { kind: 'agentChat', agentId: 'claude' } }

async function board() {
  const c = render(<SettingsProvider value={DEFAULT_SETTINGS}><div style={{ width: 800, height: 600 }}><ReactFlow nodeTypes={{ agentChat: AgentChatNode }} nodes={[node]} edges={[]} /></div></SettingsProvider>).container
  await act(async () => { await vi.dynamicImportSettled() })
  return c
}
const searchBtn = (c: HTMLElement) => c.querySelector('vscode-toolbar-button[data-title="Search"]') as HTMLElement
const field = (c: HTMLElement) => c.querySelector('.findbar vscode-textfield') as HTMLElement
const count = (c: HTMLElement) => c.querySelector('.findbar__count')?.textContent
const type = (c: HTMLElement, v: string) => act(() => { (field(c) as unknown as { value: string }).value = v; fireEvent.input(field(c)) })
const marked = () => registry.get('chat-find')?.ranges.length ?? 0
const activeText = () => registry.get('chat-find-active')?.ranges[0].startContainer.textContent

describe('Agent Chat transcript find', () => {
  it('the Search button opens the bar with aria-live count and aria-expanded', async () => {
    const c = await board()
    expect(c.querySelector('.findbar')).toBeNull()
    expect(searchBtn(c).getAttribute('aria-expanded')).toBe('false')
    await act(async () => { fireEvent.click(searchBtn(c)) })
    expect(c.querySelector('.findbar')).not.toBeNull()
    expect(searchBtn(c).getAttribute('aria-expanded')).toBe('true')
    expect(c.querySelector('.findbar__count')?.getAttribute('aria-live')).toBe('polite')
  })

  it('typing highlights and counts visible matches (case-insensitive, closed details skipped); empty clears', async () => {
    const c = await board()
    await act(async () => { fireEvent.click(searchBtn(c)) })
    type(c, 'alpha')
    expect(count(c)).toBe('1 of 3')
    expect(marked()).toBe(3)
    expect(scrolled).toHaveBeenCalled()
    type(c, '')
    expect(count(c)).toBe('')
    expect(registry.size).toBe(0)
  })

  it('Enter goes next, Shift+Enter previous, both wrap and move the active highlight', async () => {
    const c = await board()
    await act(async () => { fireEvent.click(searchBtn(c)) })
    type(c, 'alpha')
    act(() => { fireEvent.keyDown(field(c), { key: 'Enter' }) })
    expect(count(c)).toBe('2 of 3')
    act(() => { fireEvent.keyDown(field(c), { key: 'Enter' }) })
    expect(activeText()).toBe('gamma ALPHA')
    act(() => { fireEvent.keyDown(field(c), { key: 'Enter' }) })
    expect(count(c)).toBe('1 of 3')
    act(() => { fireEvent.keyDown(field(c), { key: 'Enter', shiftKey: true }) })
    expect(count(c)).toBe('3 of 3')
  })

  it('no hits shows "No matches"; Esc closes, clears highlights and returns focus to the button', async () => {
    const c = await board()
    const btn = searchBtn(c)
    btn.setAttribute('tabindex', '0') // jsdom does not run the element's own focusability
    btn.focus()
    await act(async () => { fireEvent.click(btn) })
    type(c, 'zzz')
    expect(count(c)).toBe('No matches')
    expect(marked()).toBe(0)
    type(c, 'alpha')
    expect(registry.size).toBe(2)
    act(() => { fireEvent.keyDown(field(c), { key: 'Escape' }) })
    expect(c.querySelector('.findbar')).toBeNull()
    expect(registry.size).toBe(0)
    expect(document.activeElement).toBe(btn)
  })
})
