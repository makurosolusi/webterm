/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentChatApiError } from './agentChatTransport'
import { fakeAgentChatTransport } from './agentChatTransport.fake'
import { AgentChatView } from './agentChatView'

afterEach(cleanup)

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=' // test-only 1x1
const png = (name = 'shot.png'): File => new File([Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0))], name, { type: 'image/png' })

function setup() {
  const { t, emit } = fakeAgentChatTransport()
  const view = render(<AgentChatView nodeId="n1" onNodeData={() => {}} transport={t} />)
  return { t, emit, section: view.container.querySelector('section') as HTMLElement }
}
const box = () => screen.getByLabelText('Message Claude') as HTMLTextAreaElement
const pasteFiles = (files: File[]): void => { fireEvent.paste(box(), { clipboardData: { files, items: [], getData: () => '' } }) }

describe('AgentChatView attachments', () => {
  it('a pasted image is sent as an image with the text', async () => {
    const { t } = setup()
    pasteFiles([png()])
    await screen.findByRole('img', { name: 'shot.png' })
    fireEvent.change(box(), { target: { value: 'what is this?' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(t.send).toHaveBeenCalledWith('what is this?', undefined, [{ mediaType: 'image/png', data: PNG }])
  })

  it('Retry after a failed send resends the images too', async () => {
    const { t } = setup()
    t.send.mockRejectedValueOnce(new AgentChatApiError('send', 'n1', 500, 'http_500', 'The server could not answer. Try again.'))
    pasteFiles([png()])
    await screen.findByRole('img', { name: 'shot.png' })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(await screen.findByText('Not sent (with 1 image): The server could not answer. Try again.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(t.send).toHaveBeenCalledTimes(2)
    expect(t.send).toHaveBeenLastCalledWith('', undefined, [{ mediaType: 'image/png', data: PNG }])
    await waitFor(() => expect(screen.queryByText(/Not sent/)).toBeNull())
  })

  it('a file dropped anywhere on the chat is staged and its path goes into the draft', async () => {
    const { t, section } = setup()
    const dataTransfer = { types: ['Files'], files: [new File(['a,b'], 'data.csv', { type: 'text/csv' })], dropEffect: 'none' }
    fireEvent.dragEnter(section, { dataTransfer })
    expect(section.hasAttribute('data-attach-drop')).toBe(true)
    fireEvent.drop(section, { dataTransfer })
    await waitFor(() => expect(box().value).toBe('/data/agent-chat-uploads/n1/x-data.csv '))
    expect(t.upload).toHaveBeenCalledWith(expect.any(File), 'data.csv')
  })

  it('an upload failure is shown with the file name and reason', async () => {
    const { t } = setup()
    t.upload.mockRejectedValueOnce(new AgentChatApiError('upload', 'n1', 413, 'too_large', 'The file is over the upload limit.'))
    pasteFiles([new File(['x'], 'huge.zip', { type: 'application/zip' })])
    expect((await screen.findByRole('alert')).textContent).toContain('huge.zip: The file is over the upload limit.')
  })

  it('the thread renders user images: live bytes, a transcript reference, or a placeholder', async () => {
    const { emit } = setup()
    emit(
      { seq: 1, t: 'message', messageId: 'u1', role: 'user', parts: [{ k: 'image', mediaType: 'image/png', data: PNG }, { k: 'text', text: 'look' }] },
      { seq: 2, t: 'message', messageId: 'u2', role: 'user', parts: [{ k: 'image', mediaType: 'image/png', ref: 'abc:0' }] },
      { seq: 3, t: 'message', messageId: 'u3', role: 'user', parts: [{ k: 'image', mediaType: 'image/png' }] },
    )
    const imgs = await screen.findAllByRole('img', { name: 'Attached image' }) as HTMLImageElement[]
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual([`data:image/png;base64,${PNG}`, '/api/agent-chat/n1/history?image=abc:0'])
    expect(screen.getByText('look')).toBeTruthy()
    expect(screen.getByText('[image]')).toBeTruthy()
  })
})
