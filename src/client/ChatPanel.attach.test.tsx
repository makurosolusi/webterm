/** @vitest-environment jsdom */
// Central chat attachments: a pasted image becomes a chip and is posted as an image, a text file is
// posted for inlining, a binary file is refused, and the thread renders the stored image by reference
// plus a file chip.
import { cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatPanel from './ChatPanel'
import type { ChatClient, ChatConversation, ChatMessage } from './chat/chatTypes'
import type { StreamFactory } from './chat/chatConversation'
import { centralWire } from './chat/chatCentralAttach'
import { centralImagesTooLarge } from '../shared/centralAttach'

// test-only fixtures
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
const REF = 'a'.repeat(64)
const png = (): File => new File([Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0))], 'shot.png', { type: 'image/png' })
const GLOBAL: ChatConversation = {
  id: 'central:global', scope: 'global', projectId: null, activeTurnId: null,
  lastEventSeq: 0, lastMessageSeq: 0, updatedAt: 10, title: null,
}

function makeClient(messages: ChatMessage[] = []): ChatClient & { sendMessage: ReturnType<typeof vi.fn> } {
  return {
    listConversations: vi.fn(async () => ({ items: [GLOBAL], nextOffset: null })),
    createConversation: vi.fn(async () => GLOBAL),
    listMessages: vi.fn(async () => messages),
    sendMessage: vi.fn(async () => ({ messageId: 'm1', seq: 1, turnId: 't1', status: 'queued' as const })),
    cancelTurn: vi.fn(async () => ({ status: 'cancelled' as const })),
  }
}
const streams: StreamFactory = () => ({ close: () => {} })

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function open(client: ChatClient): Promise<HTMLTextAreaElement> {
  render(<ChatPanel open client={client} streamFactory={streams} onClose={() => {}} />)
  return (await screen.findByLabelText('Message the central agent')) as HTMLTextAreaElement
}

function paste(box: HTMLTextAreaElement, files: File[]): void {
  fireEvent(box, createEvent.paste(box, { clipboardData: { files, items: [], getData: () => '' } }))
}

describe('Central chat attachments', () => {
  it('a pasted image becomes a chip and is sent as an image', async () => {
    const client = makeClient()
    const box = await open(client)
    paste(box, [png()])
    expect(await screen.findByRole('img', { name: 'shot.png' })).not.toBeNull()
    fireEvent.change(box, { target: { value: 'what is this' } })
    fireEvent.keyDown(box, { key: 'Enter' })

    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(1))
    const [, payload] = client.sendMessage.mock.calls[0] as [string, Record<string, unknown>]
    expect(payload['text']).toBe('what is this')
    expect(payload['images']).toEqual([{ mediaType: 'image/png', data: PNG }])
    expect(payload['files']).toBeUndefined()
    // The optimistic bubble shows the image right away.
    expect(screen.getAllByRole('img', { name: 'Attached image' })).toHaveLength(1)
  })

  it('a text file becomes a file chip and is sent for inlining; an image-less text-file-only message is allowed', async () => {
    const client = makeClient()
    const box = await open(client)
    paste(box, [new File(['hello file'], 'notes.md', { type: '' })])
    expect(await screen.findByText('notes.md')).not.toBeNull()
    fireEvent.keyDown(box, { key: 'Enter' })

    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(1))
    const [, payload] = client.sendMessage.mock.calls[0] as [string, Record<string, unknown>]
    expect(payload['files']).toEqual([{ name: 'notes.md', data: btoa('hello file') }])
    expect(payload['images']).toBeUndefined()
    expect(await screen.findByText('10 B')).not.toBeNull()
  })

  it('refuses a binary file with a clear reason and sends nothing', async () => {
    const client = makeClient()
    const box = await open(client)
    paste(box, [new File([new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 1])], 'tool.bin', { type: 'application/octet-stream' })])
    expect((await screen.findByRole('alert')).textContent).toContain('tool.bin: Central can read text files and images only.')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(client.sendMessage).not.toHaveBeenCalled()
  })

  it('renders a stored image by reference and a file chip in the thread', async () => {
    const client = makeClient([{
      id: 'h1', role: 'human', seq: 1, state: 'complete',
      parts: [{ type: 'image', mediaType: 'image/png', ref: REF }, { type: 'file', name: 'log.txt', size: 2048 }, { type: 'text', text: 'see' }],
    }])
    await open(client)
    const img = await screen.findByRole('img', { name: 'Attached image' })
    expect(img.getAttribute('src')).toBe(`/api/central/conversations/central%3Aglobal/messages?image=${REF}`)
    expect(screen.getByText('log.txt')).not.toBeNull()
    expect(screen.getByText('2 KB')).not.toBeNull()
  })

  it('Retry after a failed send resends the same image and file bytes', async () => {
    const client = makeClient()
    client.sendMessage.mockRejectedValueOnce(new Error('network down'))
    const box = await open(client)
    paste(box, [png(), new File(['abc'], 'a.txt', { type: 'text/plain' })])
    await screen.findByText('a.txt')
    fireEvent.change(box, { target: { value: 'look' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('button', { name: /Retry/ }))

    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(2))
    const [first, second] = client.sendMessage.mock.calls.map((c) => c[1] as Record<string, unknown>)
    expect(second?.['text']).toBe('look')
    expect(second?.['images']).toEqual(first?.['images'])
    expect(second?.['files']).toEqual([{ name: 'a.txt', data: btoa('abc') }])
  })

  it('Retry of a failed reply resends the stored image and file by reference', async () => {
    const client = makeClient([
      { id: 'h1', role: 'human', seq: 1, state: 'complete', parts: [
        { type: 'image', mediaType: 'image/png', ref: REF }, { type: 'file', name: 'log.txt', size: 3, ref: 'b'.repeat(64) }, { type: 'text', text: 'why' },
      ] },
      { id: 'a1', role: 'assistant', seq: 2, state: 'failed', parts: [{ type: 'error', code: 'runtime_error', message: 'boom' }] },
    ])
    await open(client)
    fireEvent.click(await screen.findByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(1))
    const [, payload] = client.sendMessage.mock.calls[0] as [string, Record<string, unknown>]
    expect(payload['text']).toBe('why')
    expect(payload['images']).toEqual([{ ref: REF }])
    expect(payload['files']).toEqual([{ name: 'log.txt', ref: 'b'.repeat(64) }])
  })

  it('refuses images over Central\'s stdin-safe total before posting', () => {
    const data = 'A'.repeat(3 * 1024 * 1024)
    expect(centralWire([1, 2, 3].map(() => ({ type: 'image' as const, mediaType: 'image/png', data })))).toEqual({ reason: centralImagesTooLarge() })
    expect(centralWire([{ type: 'image', mediaType: 'image/png', data: PNG }])).toEqual({ images: [{ mediaType: 'image/png', data: PNG }] })
  })
})
