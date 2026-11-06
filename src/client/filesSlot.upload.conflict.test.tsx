/** @vitest-environment jsdom */
// "Already exists" prompt of an upload (VS Code file conflict): Replace / Keep Both / Skip, apply to all.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fs = vi.hoisted(() => ({
  capabilities: vi.fn(),
  resetCapabilitiesCache: vi.fn(),
  rawUrl: (p: string) => `/api/fs/raw?path=${encodeURIComponent(p)}`,
}))
vi.mock('./fsClient', () => fs)

import { resetFilesNotices } from './filesNotice'
import { resetUploadSlot } from './filesSlot.upload'
import { CONFLICT_TEXT } from './filesSlot.upload.conflict'
import { FakeXhr, Host, dropFiles, mkCtx, sent, settle } from './filesSlot.upload.harness'

const caps = { mutate: true, viewers: true, watch: false, git: false, quickOpen: false, upload: true, listMax: 1 }
const EEXIST = '{"ok":false,"code":"EEXIST","error":"exists"}'
/** Names in `taken` exist on the server; overwrite=1 always succeeds. */
const existing = (...taken: string[]) => {
  FakeXhr.replyFor = (n, q) => (taken.includes(n) && !q.get('overwrite') ? EEXIST : '{"ok":true}')
}

beforeEach(() => {
  resetUploadSlot()
  resetFilesNotices()
  FakeXhr.reset()
  fs.capabilities.mockResolvedValue(caps)
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const foot = () => screen.getByTestId('foot').textContent
async function dropInto(names: string[]) {
  render(<Host ctx={mkCtx()} />)
  await settle()
  dropFiles(screen.getByTestId('node'), names)
  await settle()
}
const press = async (name: string) => { fireEvent.click(screen.getByRole('button', { name })); await settle() }

describe('upload conflict dialog', () => {
  it('asks VS Code style; a single file has no "apply to all"; Replace re-sends with overwrite=1', async () => {
    existing('a.txt')
    await dropInto(['a.txt'])
    const dlg = screen.getByRole('alertdialog')
    expect(dlg.textContent).toContain(CONFLICT_TEXT.title('a.txt', 'p'))
    expect(screen.queryByRole('checkbox')).toBeNull()
    await press(CONFLICT_TEXT.replace)
    expect(sent()).toEqual(['a.txt', 'a.txt+ow'])
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(foot()).toBe('1 file uploaded')
  })

  it('Keep Both uploads under the next free VS Code copy name', async () => {
    existing('a.txt', 'a copy.txt')
    await dropInto(['a.txt'])
    await press(CONFLICT_TEXT.keep)
    expect(sent()).toEqual(['a.txt', 'a copy.txt', 'a copy 2.txt'])
    expect(foot()).toBe('1 file uploaded')
  })

  it('Skip leaves the existing file alone and reports it as skipped', async () => {
    existing('a.txt')
    await dropInto(['a.txt', 'b.txt'])
    await press(CONFLICT_TEXT.skip)
    expect(sent()).toEqual(['a.txt', 'b.txt'])
    expect(foot()).toBe('1 file uploaded, 1 skipped')
  })

  it('Esc closes the dialog as Skip, never as Replace', async () => {
    existing('a.txt')
    await dropInto(['a.txt'])
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    await settle()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(sent()).toEqual(['a.txt'])
    expect(foot()).toBe('1 file skipped')
  })

  it('"Apply to all remaining conflicts" answers every later conflict of the batch', async () => {
    existing('a.txt', 'b.txt', 'c.txt')
    await dropInto(['a.txt', 'b.txt', 'c.txt'])
    fireEvent.click(screen.getByRole('checkbox', { name: CONFLICT_TEXT.applyAll }))
    await press(CONFLICT_TEXT.replace)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(sent()).toEqual(['a.txt', 'a.txt+ow', 'b.txt', 'b.txt+ow', 'c.txt', 'c.txt+ow'])
    expect(foot()).toBe('3 files uploaded')
  })

  it('without "apply to all" each conflict asks again, with the checkbox reset', async () => {
    existing('a.txt', 'b.txt')
    await dropInto(['a.txt', 'b.txt'])
    await press(CONFLICT_TEXT.skip)
    expect(screen.getByRole('alertdialog').textContent).toContain(CONFLICT_TEXT.title('b.txt', 'p'))
    // The last queued file has nothing remaining after it, so the checkbox is gone.
    expect(screen.queryByRole('checkbox')).toBeNull()
    await press(CONFLICT_TEXT.replace)
    expect(sent()).toEqual(['a.txt', 'b.txt', 'b.txt+ow'])
    expect(foot()).toBe('1 file uploaded, 1 skipped')
  })
})
