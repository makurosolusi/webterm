/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentChatNodeConfig } from '../../shared/agentChat.shape'
import { AgentChatApiError } from './agentChatTransport'
import { fakeAgentChatTransport, initEvent } from './agentChatTransport.fake'
import { AgentChatView } from './agentChatView'

vi.mock('../fsClient', () => ({
  search: vi.fn(async () => ({ ok: true, files: ['src/main.ts', 'README.md'], truncated: false })),
}))
const { search } = await import('../fsClient')

afterEach(cleanup)
// jsdom lacks the ResizeObserver / pointer-capture APIs the Radix popper menu calls when it opens.
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.scrollIntoView ??= () => undefined
})

type Fake = ReturnType<typeof fakeAgentChatTransport>
function setup(props: { chatSessionId?: string; chatConfig?: AgentChatNodeConfig; cwd?: string } = {}, prep?: (t: Fake['t']) => void) {
  const f = fakeAgentChatTransport()
  prep?.(f.t)
  const onNodeData = vi.fn()
  render(<AgentChatView nodeId="n1" onNodeData={onNodeData} transport={f.t} {...props} />)
  return { ...f, onNodeData }
}
const box = () => screen.getByLabelText('Message Claude') as HTMLTextAreaElement
const type = (text: string): void => { fireEvent.change(box(), { target: { value: text } }) }
const enter = (): void => { fireEvent.keyDown(box(), { key: 'Enter' }) }
const options = (): string[] => screen.queryAllByRole('option').map((o) => o.querySelector('.cmp-name')!.textContent!)

describe('AgentChatView controls', () => {
  it('"/" lists the catalog plus the chat-handled pickers', async () => {
    const { t, emit } = setup()
    t.catalog.mockResolvedValueOnce([{ name: 'deploy', description: 'Ship it', builtin: false }])
    emit()
    type('/')
    await waitFor(() => expect(options()).toEqual(expect.arrayContaining(['/deploy', '/model', '/resume'])))
    expect(screen.getByText('Ship it')).toBeTruthy()
  })

  it('"/" falls back to the built-in commands when the catalog fails', async () => {
    const { t, emit } = setup()
    t.catalog.mockRejectedValueOnce(new AgentChatApiError('catalog', 'n1', 503, 'claude_unavailable', 'Claude could not start.'))
    emit()
    type('/')
    await waitFor(() => expect(options()).toEqual(expect.arrayContaining(['/compact', '/clear', '/model'])))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('"@" lists files of the folder init reports, and their folders', async () => {
    const { emit, onNodeData } = setup({ cwd: '~/w' })
    emit(initEvent(1, 's1', { cwd: '/home/u/w' }))
    await waitFor(() => expect(onNodeData).toHaveBeenCalledWith({ chatSessionId: 's1' }))
    type('@')
    await waitFor(() => expect(options()).toEqual(expect.arrayContaining(['@src/main.ts', '@README.md', '@src/'])))
    expect(search).toHaveBeenCalledWith('/home/u/w', '*')
  })

  it('a model picked in the footer goes to setConfig, and the config event is saved on the node', async () => {
    const { t, emit, onNodeData } = setup({}, (fake) => fake.models.mockResolvedValue([{ value: 'default', displayName: 'Default' }, { value: 'sonnet', displayName: 'Sonnet' }]))
    emit({ seq: 1, t: 'config', config: { thinking: true } })
    await waitFor(() => expect(onNodeData).toHaveBeenCalledWith({ chatConfig: { thinking: true } }))
    fireEvent.keyDown(screen.getByRole('button', { name: /^Model:/ }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Sonnet' }))
    expect(t.setConfig).toHaveBeenCalledWith({ model: 'sonnet' })
    emit({ seq: 2, t: 'config', config: { model: 'sonnet', thinking: true } })
    await waitFor(() => expect(onNodeData).toHaveBeenCalledWith({ chatConfig: { model: 'sonnet', thinking: true } }))
  })

  it('re-applies the stored config when the stream opens, not again when the server already has it', async () => {
    let answer: () => void = () => undefined
    const { t, emit, status, onNodeData } = setup({ chatConfig: { model: 'opus', thinking: false } },
      (fake) => fake.setConfig.mockImplementationOnce(() => new Promise<undefined>((r) => { answer = () => r(undefined) })))
    const model = () => screen.getByRole('button', { name: /^Model:/ }).getAttribute('aria-label')
    emit()
    expect(t.setConfig).toHaveBeenCalledWith({ model: 'opus', thinking: false })
    // The replayed (older) server config does not overwrite the stored one while the sync runs.
    emit({ seq: 1, t: 'config', config: { thinking: true } })
    await waitFor(() => expect(model()).toBe('Model: Auto (ladder: Sonnet · medium)'))
    emit({ seq: 2, t: 'config', config: { model: 'opus', thinking: false } })
    await waitFor(() => expect(model()).toBe('Model: opus'))
    await act(async () => answer())
    status('reconnecting')
    status('open')
    expect(t.setConfig).toHaveBeenCalledTimes(1)
    expect(onNodeData).not.toHaveBeenCalledWith({ chatConfig: { thinking: true } })
  })

  it('a reset clears the stored session id at once; the next init stores the new one', async () => {
    const { emit, onNodeData } = setup({ chatSessionId: 'old' })
    emit({ seq: 1, t: 'reset', sessionId: '' })
    await waitFor(() => expect(onNodeData).toHaveBeenCalledWith({ chatSessionId: undefined }))
    emit(initEvent(2, 'fresh'))
    await waitFor(() => expect(onNodeData).toHaveBeenCalledWith({ chatSessionId: 'fresh' }))
    emit({ seq: 3, t: 'reset', sessionId: 'past' })
    await waitFor(() => expect(onNodeData).toHaveBeenLastCalledWith({ chatSessionId: 'past' }))
  })

  it('/model opens the model picker instead of sending', async () => {
    const { t, emit } = setup()
    emit()
    type('/model')
    enter()
    expect((await screen.findByRole('menu')).getAttribute('aria-label')).toBe('Models')
    expect(t.send).not.toHaveBeenCalled()
    expect(box().value).toBe('')
  })

  it('/resume opens the conversation history instead of sending', async () => {
    const { t, emit } = setup()
    emit()
    type('/resume')
    enter()
    expect(await screen.findByRole('dialog', { name: 'Conversation history' })).toBeTruthy()
    expect(t.sessions).toHaveBeenCalledTimes(1)
    expect(t.send).not.toHaveBeenCalled()
  })

  it('/clear starts a new conversation, and a refusal while busy shows the reason', async () => {
    const { t, emit } = setup()
    emit()
    t.newConversation.mockRejectedValueOnce(new AgentChatApiError('new conversation', 'n1', 409, 'busy', 'Claude is working in this chat.'))
    type('/clear')
    enter()
    expect(t.newConversation).toHaveBeenCalledTimes(1)
    expect(t.send).not.toHaveBeenCalled()
    expect((await screen.findByRole('alert')).textContent).toBe('Could not start a new conversation: Claude is working in this chat.')
  })

  it('shows the todo panel once Claude writes todos, and Escape stops a running turn', async () => {
    const { t, emit } = setup()
    emit(
      { seq: 1, t: 'status', status: 'tool' },
      { seq: 2, t: 'tool', id: 'tw', name: 'TodoWrite', state: 'running', input: { todos: [
        { content: 'Read code', status: 'completed' }, { content: 'Fix bug', status: 'in_progress', activeForm: 'Fixing bug' },
      ] } },
    )
    const panel = await screen.findByRole('region', { name: 'Todo list' })
    expect(panel.textContent).toContain('1/2')
    expect(panel.textContent).toContain('Fixing bug')
    fireEvent.keyDown(box(), { key: 'Escape' })
    expect(t.interrupt).toHaveBeenCalledTimes(1)
  })

  it('disables model, effort and history while disconnected', () => {
    setup()
    expect((screen.getByRole('button', { name: /^Model:/ }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Conversation history' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
