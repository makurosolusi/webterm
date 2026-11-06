/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ChatComposer from '../chat/chatComposer'
import { agentChatCompletion, FALLBACK_COMMANDS, type ComposerCompletion, type CompletionItem } from './composerCompletion'
import { MENU_TEXT } from './completionMenu'

afterEach(cleanup)

const box = (): HTMLTextAreaElement => screen.getByLabelText('Message Claude') as HTMLTextAreaElement
const type = (text: string): void => { fireEvent.change(box(), { target: { value: text } }) }
const options = (): string[] => screen.queryAllByRole('option').map((o) => o.querySelector('.cmp-name')!.textContent!)
const key = (k: string, extra: object = {}): void => { fireEvent.keyDown(box(), { key: k, ...extra }) }

const ITEMS: CompletionItem[] = [
  { value: 'compact', description: 'Summarize the conversation', argumentHint: '[instructions]', badge: 'built-in' },
  { value: 'clear', description: 'Start over', badge: 'built-in' },
  { value: 'review', description: 'Review a PR', badge: 'custom' },
]
const sync: ComposerCompletion = { provider: (t) => (t.kind === 'slash' ? ITEMS.filter((i) => i.value.startsWith(t.query)) : []) }

function setup(completion: ComposerCompletion = sync, busy = false) {
  const onSend = vi.fn()
  const onStop = vi.fn()
  render(<ChatComposer busy={busy} onSend={onSend} onStop={onStop} label="Message Claude" completion={completion} />)
  return { onSend, onStop }
}

describe('completion menu in the composer', () => {
  it('"/" opens a listbox with name, argument hint, description and badge', () => {
    setup()
    type('/')
    const list = screen.getByRole('listbox', { name: 'Commands and skills' })
    expect(options()).toEqual(['/compact', '/clear', '/review'])
    const first = screen.getAllByRole('option')[0]
    expect(first.textContent).toContain('[instructions]')
    expect(first.textContent).toContain('Summarize the conversation')
    expect(first.querySelector('.cmp-badge')!.textContent).toBe('built-in')
    expect(box().getAttribute('role')).toBe('combobox')
    expect(box().getAttribute('aria-controls')).toBe(list.id)
    expect(box().getAttribute('aria-activedescendant')).toBe(first.id)
  })

  it('does not open for "/" mid-text', () => {
    setup()
    type('see /usr')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('↑/↓ move (wrapping), Enter accepts without sending', () => {
    const { onSend } = setup()
    type('/')
    key('ArrowDown')
    expect(screen.getAllByRole('option')[1].getAttribute('aria-selected')).toBe('true')
    key('ArrowUp')
    key('ArrowUp')
    expect(screen.getAllByRole('option')[2].getAttribute('aria-selected')).toBe('true')
    key('Enter')
    expect(box().value).toBe('/review ')
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('Tab accepts; Enter on an exactly typed command sends it', () => {
    const { onSend } = setup()
    type('/cl')
    key('Tab')
    expect(box().value).toBe('/clear ')
    type('/clear')
    key('Enter')
    expect(onSend).toHaveBeenCalledWith('/clear', [])
  })

  it('mouse hover selects and click accepts', () => {
    setup()
    type('/')
    const opt = screen.getAllByRole('option')[2]
    fireEvent.mouseEnter(opt)
    expect(opt.getAttribute('aria-selected')).toBe('true')
    fireEvent.click(opt)
    expect(box().value).toBe('/review ')
  })

  it('Escape closes the menu first, then stops the running turn', () => {
    const { onStop } = setup(sync, true)
    type('/')
    expect(screen.getByRole('listbox')).toBeTruthy()
    key('Escape')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(onStop).not.toHaveBeenCalled()
    key('Escape')
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('shows the empty state', () => {
    setup()
    type('/zzz')
    expect(screen.getByRole('status').textContent).toBe(MENU_TEXT.empty.slash)
    expect(screen.queryAllByRole('option')).toHaveLength(0)
  })

  it('shows loading, then the items', async () => {
    let resolve!: (items: CompletionItem[]) => void
    setup({ provider: () => new Promise((r) => { resolve = r }) })
    type('/')
    expect(screen.getByRole('status').textContent).toBe(MENU_TEXT.loading.slash)
    await act(async () => { resolve(ITEMS) })
    expect(options()).toHaveLength(3)
  })

  it('shows the error state when the provider rejects', async () => {
    setup({ provider: async () => { throw new Error('search failed') } })
    type('@x')
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', `${MENU_TEXT.failed}search failed`)
  })

  it('uses the built-in fallback list when loadCommands rejects', async () => {
    setup(agentChatCompletion({ loadCommands: async () => { throw new Error('down') }, searchFiles: async () => [] }))
    type('/')
    await screen.findAllByRole('option')
    expect(options()).toHaveLength(FALLBACK_COMMANDS.length)
    expect(options()).toContain('/compact')
  })

  it('"@" mid-text: a folder drills in and keeps the menu open, a file closes it', async () => {
    setup(agentChatCompletion({ loadCommands: async () => [], searchFiles: async () => [{ path: 'src/main.ts', dir: false }] }))
    type('fix @sr')
    await screen.findAllByRole('option')
    expect(options()[0]).toBe('@src/')
    key('Enter')
    expect(box().value).toBe('fix @src/')
    await screen.findByText('@src/main.ts')
    expect(options()).toEqual(['@src/main.ts'])
    key('Enter')
    expect(box().value).toBe('fix @src/main.ts ')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('a bare "@" + Enter sends instead of accepting', async () => {
    const { onSend } = setup(agentChatCompletion({ loadCommands: async () => [], searchFiles: async () => [{ path: 'a.ts', dir: false }] }))
    type('hello @')
    await screen.findAllByRole('option')
    key('Enter')
    expect(onSend).toHaveBeenCalledWith('hello @', [])
  })
})
