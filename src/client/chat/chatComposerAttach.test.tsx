/** @vitest-environment jsdom */
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ChatComposer from './chatComposer'
import { DROP_ATTR, type AttachFiles } from './chatComposerAttach'
import { prepareImage } from './chatAttach'

afterEach(cleanup)

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=' // test-only 1x1
const png = (name = 'shot.png'): File => new File([Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0))], name, { type: 'image/png' })
const box = (): HTMLTextAreaElement => screen.getByLabelText('Message the central agent') as HTMLTextAreaElement

/** Images become pending images; any other file becomes a path for the draft. */
const resolver = (): AttachFiles & ReturnType<typeof vi.fn> => vi.fn(async (files: File[]) => {
  const images = await Promise.all(files.filter((f) => f.type.startsWith('image/')).map(prepareImage))
  const paths = files.filter((f) => !f.type.startsWith('image/')).map((f) => `/up/${f.name}`)
  return { images, text: paths.length ? `${paths.join(' ')} ` : '', failed: [] }
}) as never

function setup(attach: AttachFiles | undefined = resolver()) {
  const onSend = vi.fn()
  const view = render(<ChatComposer busy={false} onSend={onSend} onStop={() => {}} attach={attach} />)
  return { onSend, attach, root: view.container.querySelector('.chat-composer') as HTMLElement }
}

/** Dispatches a paste carrying `data`; true when the composer took it (default prevented). */
function paste(data: { files?: File[]; text?: string }): boolean {
  const ev = createEvent.paste(box(), { clipboardData: { files: data.files ?? [], items: [], getData: (t: string) => (t === 'text/plain' ? data.text ?? '' : '') } })
  fireEvent(box(), ev)
  return ev.defaultPrevented
}

describe('ChatComposer attachments', () => {
  it('a pasted image becomes a thumbnail chip, not text', async () => {
    const { attach } = setup()
    expect(paste({ files: [png()] })).toBe(true)
    const thumb = await screen.findByRole('img', { name: 'shot.png' }) as HTMLImageElement
    expect(thumb.src).toBe(`data:image/png;base64,${PNG}`)
    expect(box().value).toBe('')
    expect(attach).toHaveBeenCalledTimes(1)
  })

  it('pasted plain text stays the textarea\'s', () => {
    const { attach } = setup()
    expect(paste({ text: 'just words' })).toBe(false)
    expect(attach).not.toHaveBeenCalled()
    expect(screen.queryByRole('list', { name: 'Attached images' })).toBeNull()
  })

  it('a file drop lights the zone up, then attaches; a non-image file lands in the draft as a path', async () => {
    const { root } = setup()
    const dataTransfer = { types: ['Files'], files: [png('drop.png'), new File(['x'], 'notes.txt', { type: 'text/plain' })], dropEffect: 'none' }
    fireEvent.dragEnter(root, { dataTransfer })
    expect(root.hasAttribute(DROP_ATTR)).toBe(true)
    fireEvent.dragOver(root, { dataTransfer })
    fireEvent.drop(root, { dataTransfer })
    expect(root.hasAttribute(DROP_ATTR)).toBe(false)
    expect(await screen.findByRole('img', { name: 'drop.png' })).toBeTruthy()
    await waitFor(() => expect(box().value).toBe('/up/notes.txt '))
  })

  it('a chip can be removed before sending', async () => {
    setup()
    paste({ files: [png('a.png')] })
    await screen.findByRole('img', { name: 'a.png' })
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.png' }))
    expect(screen.queryByRole('img', { name: 'a.png' })).toBeNull()
    expect((screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('Enter sends text and images together; an image-only message is allowed; chips clear after', async () => {
    const { onSend } = setup()
    paste({ files: [png()] })
    await screen.findByRole('img', { name: 'shot.png' })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).toHaveBeenLastCalledWith('', [{ name: 'shot.png', mediaType: 'image/png', data: PNG }])
    expect(screen.queryByRole('img', { name: 'shot.png' })).toBeNull()
    paste({ files: [png('b.png')] })
    await screen.findByRole('img', { name: 'b.png' })
    fireEvent.change(box(), { target: { value: 'what is this?' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).toHaveBeenLastCalledWith('what is this?', [expect.objectContaining({ name: 'b.png' })])
  })

  it('the attach button opens a picker whose files are attached', async () => {
    const { attach } = setup()
    const input = screen.getByTestId('chat-attach-input') as HTMLInputElement
    const click = vi.spyOn(input, 'click')
    fireEvent.click(screen.getByRole('button', { name: 'Attach files' }))
    expect(click).toHaveBeenCalled()
    fireEvent.change(input, { target: { files: [png('picked.png')] } })
    expect(await screen.findByRole('img', { name: 'picked.png' })).toBeTruthy()
    expect(attach).toHaveBeenCalledWith([expect.objectContaining({ name: 'picked.png' })])
  })

  it('shows attaching, blocks sending meanwhile, then reports a failure with its reason', async () => {
    let finish: (v: Awaited<ReturnType<AttachFiles>>) => void = () => {}
    const attach: AttachFiles = () => new Promise((r) => { finish = r })
    setup(attach)
    fireEvent.change(box(), { target: { value: 'hi' } })
    paste({ files: [png('big.png')] })
    expect(await screen.findByText('Attaching big.png…')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => finish({ images: [], text: '', failed: ['big.png: big.png is over 5 MB.'] }))
    expect(screen.getByRole('alert').textContent).toContain('Could not attach: big.png: big.png is over 5 MB.')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss attach error' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('without `attach` there is no attach button and a pasted file is left alone', () => {
    render(<ChatComposer busy={false} onSend={() => {}} onStop={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Attach files' })).toBeNull()
    expect(paste({ files: [png()] })).toBe(false)
  })
})
