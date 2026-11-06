/** @vitest-environment jsdom */
// Per-node cleanup of the real FilesNode: removing the node drops its notices and its upload queue
// (aborting the running request); a re-render of the same node keeps both.
import type { ComponentProps } from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'

const list = vi.hoisted(() => vi.fn())
vi.mock('./fsClient', async () => ({
  list, mkdir: vi.fn(), write: vi.fn(), stat: vi.fn(), listV2: vi.fn(),
  ...(await import('./filesCaps.fixture')).capsMock(),
  capabilities: async () => (await import('./filesCaps.fixture')).capsWith({ upload: true, mutate: true }),
}))

import FilesNode from './FilesNode'
import { noticesOf, resetFilesNotices } from './filesNotice'
import { UPLOAD_NOTICE, UPLOAD_TEXT, resetUploadSlot, runUpload } from './filesSlot.upload'
import { FakeXhr, mkCtx, settle } from './filesSlot.upload.harness'

const ID = 'f1'
const props = (title: string) => ({ id: ID, data: { dirPath: '/p', title }, selected: false }) as unknown as ComponentProps<typeof FilesNode>
const node = (title = 't') => <ReactFlowProvider><FilesNode {...props(title)} /></ReactFlowProvider>

beforeEach(() => {
  resetUploadSlot(); resetFilesNotices(); FakeXhr.reset()
  FakeXhr.hold = true
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
  list.mockResolvedValue([{ name: 'a.txt', dir: false }])
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/** Mount the node and start a held upload of one file on it. */
async function uploading() {
  const view = render(node())
  await settle()
  act(() => runUpload(mkCtx({ nodeId: ID }), '/p', [new File(['xx'], 'big.bin')]))
  await waitFor(() => expect(FakeXhr.all).toHaveLength(1))
  expect(noticesOf(ID).map((n) => n.text)).toEqual([UPLOAD_TEXT.progress(1, 1, 'big.bin')])
  return view
}

describe('FilesNode removal', () => {
  it('unmount aborts the running upload and leaves no notice entry, even after the batch settles', async () => {
    const view = await uploading()
    view.unmount()
    expect(FakeXhr.all[0].aborted).toBe(true)
    expect(noticesOf(ID)).toHaveLength(0)
    await settle()
    // The cancelled batch's done callback must not re-create the entry ("Upload cancelled").
    expect(noticesOf(ID)).toHaveLength(0)
  })

  it('a re-render of the same node keeps the upload running and its notice', async () => {
    const view = await uploading()
    view.rerender(node('renamed'))
    await settle()
    expect(FakeXhr.all[0].aborted).toBe(false)
    expect(noticesOf(ID).map((n) => n.id)).toEqual([UPLOAD_NOTICE])
  })

  it('after removal a new node with the same id starts with a fresh queue', async () => {
    ;(await uploading()).unmount()
    FakeXhr.hold = false
    render(node())
    await settle()
    act(() => runUpload(mkCtx({ nodeId: ID }), '/p', [new File(['x'], 'next.txt')]))
    await settle()
    expect(FakeXhr.all.map((x) => x.q.get('name'))).toEqual(['big.bin', 'next.txt'])
    expect(noticesOf(ID).map((n) => n.text)).toEqual([UPLOAD_TEXT.done(1, 0)])
  })
})
