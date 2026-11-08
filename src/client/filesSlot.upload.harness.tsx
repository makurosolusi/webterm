// Test-only harness for the upload slot tests: a FilesNode-like host (rows, progress bar, footer notice,
// overlay), a controllable fake XMLHttpRequest, and OS drag/drop event builders. Each test file still
// declares its own `vi.mock('./fsClient')` (mocks are hoisted per file).
import { act } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { vi } from 'vitest'
import type { FileMeta } from '../shared/fsContract'
import { dismissNotice, notify } from './filesNotice'
import { FilesNoticeLine, FilesProgressBar } from './FilesNoticeLine'
import type { FilesSlotCtx } from './filesSlots'
import { uploadSlot } from './filesSlot.upload'
import { FilesWriteOffer } from './filesWriteOffer'

export const entries: FileMeta[] = [{ name: 'a.txt', dir: false, ignored: false }, { name: 'sub', dir: true, ignored: false }]

/** Ctx bound to the real notice store, as FilesNode builds it. */
export const mkCtx = (o: Partial<FilesSlotCtx> = {}): FilesSlotCtx => {
  const nodeId = o.nodeId ?? 'n1'
  return {
    cwd: '/p', dir: '/p', entries, selection: [], expanded: new Set(), toggle: vi.fn(), collapseAll: vi.fn(), startRenameAt: vi.fn(), refresh: vi.fn(), open: vi.fn(), startInput: vi.fn(), nodeId,
    notify: (n) => notify(nodeId, n), dismiss: (id) => dismissNotice(nodeId, id), ...o,
  }
}

/** FilesNode in miniature: useSlot each render, rows as tree items, progress bar, footer, toolbar, overlay. */
export function Host({ ctx }: { ctx: FilesSlotCtx }): ReactNode {
  uploadSlot.useSlot?.(ctx)
  return (
    <div data-id={ctx.nodeId} data-testid="node">
      <div className="files-node" data-testid="body">
        <div data-testid="toolbar">{uploadSlot.toolbar?.(ctx)}</div>
        <FilesProgressBar nodeId={ctx.nodeId} />
        <div data-testid="list">
          {ctx.entries.map((e, i) => createElement('vscode-tree-item', { key: e.name, 'data-index': i, 'data-testid': `row-${e.name}` },
            <div className="files-row"><span className="files-name">{e.name}</span></div>))}
        </div>
        <div className="files-foot" data-testid="foot" role="status" aria-live="polite">
          <FilesNoticeLine nodeId={ctx.nodeId} fallback={`${ctx.entries.length} of ${ctx.entries.length}`} />
        </div>
        {uploadSlot.overlay?.(ctx)}
        <FilesWriteOffer nodeId={ctx.nodeId} />
      </div>
    </div>
  )
}

/** XHR double: replies on a microtask unless `hold`; held requests are answered with `reply()`. */
export class FakeXhr {
  static all: FakeXhr[] = []
  static hold = false
  static replyFor: (name: string, q: URLSearchParams) => string = () => '{"ok":true}'
  static reset(): void { FakeXhr.all = []; FakeXhr.hold = false; FakeXhr.replyFor = () => '{"ok":true}' }
  upload: { onprogress?: (e: unknown) => void } = {}
  onload?: () => void; onabort?: () => void; onerror?: () => void
  status = 200; responseText = ''; url = ''; aborted = false
  get q(): URLSearchParams { return new URL(this.url, 'http://x').searchParams }
  open(_m: string, u: string) { this.url = u }
  send() {
    FakeXhr.all.push(this)
    if (!FakeXhr.hold) queueMicrotask(() => this.reply())
  }
  progress(loaded: number, total: number) { this.upload.onprogress?.({ lengthComputable: true, loaded, total }) }
  reply(text = FakeXhr.replyFor(this.q.get('name') ?? '', this.q)) { this.responseText = text; this.onload?.() }
  abort() { this.aborted = true; this.onabort?.() }
}
/** `name[+ow] -> dir` of every request so far. */
export const sent = () => FakeXhr.all.map((x) => `${x.q.get('name')}${x.q.get('overwrite') ? '+ow' : ''}`)

export const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)) })

/** Dispatch an OS-files drag event (`type`) at `el`; `types` lets a test fake an internal drag. */
export function drag(el: Element, type: 'dragenter' | 'dragover' | 'dragleave' | 'drop', names: string[] = ['x.txt'], types = ['Files']): Event {
  const files = names.map((n) => new File(['xx'], n))
  const dt = { types, files, items: [] as unknown[], dropEffect: '' }
  const ev = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(ev, { dataTransfer: dt })
  act(() => { el.dispatchEvent(ev) })
  return ev
}
export const dropFiles = (el: Element, names: string[]) => drag(el, 'drop', names)
