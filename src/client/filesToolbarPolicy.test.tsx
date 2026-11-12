/** @vitest-environment jsdom */
// Policy: a Files slot `overflow()` contributes labelled rows to the title bar's "…" menu (it never draws
// its own toolbar icons). Messages (progress, results, errors) belong in the footer notice (`ctx.notify`).
// Every slot with overflow rows is checked with all capabilities on, so a slot that adds one later is covered.
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
  return <div data-id={ctx.nodeId}><div className="files-node" /></div>
}

beforeEach(() => {
  // Slots may poll the server on mount (git status, watch); answer with an empty success.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }))))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const withOverflow = FILES_SLOTS.filter((s) => s.overflow)

it('at least one slot has overflow rows (the policy is not vacuous)', () => {
  expect(withOverflow.map((s) => s.id)).toContain('upload')
})

it.each(withOverflow.map((s) => [s.id, s] as const))('slot %s overflow rows each carry a label and an icon', async (_id, slot) => {
  const view = render(<Host slot={slot} />)
  await act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)) })
  view.rerender(<Host slot={slot} />)
  const rows = slot.overflow?.(ctx) ?? []
  expect(rows.length).toBeGreaterThan(0)
  for (const r of rows) {
    if (!('label' in r)) continue
    expect(r.label.trim()).toBeTruthy()
    expect(r.icon).toBeTruthy()
  }
})
