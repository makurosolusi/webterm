/** @vitest-environment jsdom */
// Policy: a Files slot `toolbar()` renders icon controls only. Messages (progress, results, errors) belong
// in the footer notice (`ctx.notify`), never as text in the toolbar. Every slot with a toolbar is checked
// with all capabilities on, so a slot that later adds one is covered without editing this test.
import { act, cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const allOn = { mutate: true, viewers: true, watch: true, git: true, quickOpen: true, upload: true, listMax: 1000 }
vi.mock('./fsClient', async (orig) => ({ ...(await orig<typeof import('./fsClient')>()), capabilities: vi.fn(async () => allOn) }))

import { FILES_SLOTS, type FilesSlot, type FilesSlotCtx } from './filesSlots'

const ctx: FilesSlotCtx = {
  cwd: '/p', dir: '/p', entries: [{ name: 'a.txt', dir: false, ignored: false }], selection: ['a.txt'], nodeId: 'policy',
  expanded: new Set(), toggle: () => {}, collapseAll: () => {}, startRenameAt: () => {}, refresh: () => {}, open: () => {}, startInput: () => {}, notify: () => '', dismiss: () => {},
}

function Host({ slot }: { slot: FilesSlot }): ReactNode {
  slot.useSlot?.(ctx)
  return <div data-id={ctx.nodeId}><div className="files-node"><span data-testid="tool">{slot.toolbar?.(ctx)}</span></div></div>
}

beforeEach(() => {
  // Slots may poll the server on mount (git status, watch); answer with an empty success.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }))))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const withToolbar = FILES_SLOTS.filter((s) => s.toolbar)

it('at least one slot has a toolbar (the policy is not vacuous)', () => {
  expect(withToolbar.map((s) => s.id)).toContain('upload')
})

it.each(withToolbar.map((s) => [s.id, s] as const))('slot %s toolbar renders icon buttons only, no visible text', async (_id, slot) => {
  const view = render(<Host slot={slot} />)
  await act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)) })
  view.rerender(<Host slot={slot} />)
  const tool = view.getByTestId('tool')
  const buttons = [...tool.querySelectorAll('button')]
  expect(buttons.length).toBeGreaterThan(0)
  expect(tool.textContent?.trim()).toBe('')
  for (const b of buttons) expect(b.getAttribute('aria-label')?.trim()).toBeTruthy()
})
