/** @vitest-environment jsdom */
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FileMeta, FsCapabilities, GitBranch, GitMark } from '../shared/fsContract'
import { emitFsEvent } from './fsEvents'
import { gitSlot } from './filesSlot.git'
import type { FilesSlotCtx } from './filesSlots'

const h = vi.hoisted(() => ({ caps: vi.fn(), status: vi.fn() }))
vi.mock('./fsClient', () => ({ capabilities: h.caps, gitStatus: h.status }))

const file = (name: string, dir = false): FileMeta => ({ name, dir, ignored: false })
const ctx = (over: Partial<FilesSlotCtx> = {}): FilesSlotCtx =>
  ({ cwd: '/r', dir: '/r', entries: [], selection: [], refresh: () => {}, open: () => {}, startInput: vi.fn(), nodeId: 'n1', notify: vi.fn(), dismiss: vi.fn(), ...over })
const ok = (marks: Record<string, GitMark>, branch?: GitBranch) => ({ ok: true, marks, ...(branch && { branch }) })
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
const caps = (git: boolean) => ({ git }) as FsCapabilities

beforeEach(() => { vi.useFakeTimers(); h.caps.mockResolvedValue(caps(true)) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks() })

it('dekorasi: huruf+kelas untuk file, titik untuk folder, kosong tanpa mark', async () => {
  h.status.mockResolvedValue(ok({ 'a.txt': 'M', src: 'D', 'é.txt': 'U' }))
  const c = ctx()
  renderHook(() => gitSlot.useSlot!(c))
  await flush()
  expect(gitSlot.decorate!(file('a.txt'), c)).toEqual({ badge: 'M', title: 'Modified', className: 'files-git--M' })
  expect(gitSlot.decorate!(file('src', true), c)).toEqual({ badge: '•', title: 'Contains deleted items', className: 'files-git--D' })
  expect(gitSlot.decorate!(file('é.txt'), c)).toMatchObject({ badge: 'U' }) // NFD cocok kunci NFC
  expect(gitSlot.decorate!(file('clean.txt'), c)).toBeUndefined()
  expect(h.status).toHaveBeenCalledWith('/r')
})

it('capabilities.git=false: tidak memanggil git-status dan tanpa dekorasi', async () => {
  h.caps.mockResolvedValue(caps(false))
  const c = ctx()
  renderHook(() => gitSlot.useSlot!(c))
  await flush()
  emitFsEvent({ kind: 'dirty', path: '/r', origin: 'remote' })
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(h.status).not.toHaveBeenCalled()
  expect(gitSlot.decorate!(file('a.txt'), c)).toBeUndefined()
})

it('event fs (lokal/remote) memuat ulang dengan debounce: badai event = satu panggilan', async () => {
  h.status.mockResolvedValueOnce(ok({ 'a.txt': 'M' })).mockResolvedValue(ok({ 'a.txt': 'A' }))
  const c = ctx()
  renderHook(() => gitSlot.useSlot!(c))
  await flush()
  expect(h.status).toHaveBeenCalledTimes(1)
  for (let i = 0; i < 5; i++) emitFsEvent({ kind: 'written', path: '/r/a.txt', origin: i % 2 ? 'local' : 'remote' })
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(h.status).toHaveBeenCalledTimes(2)
  expect(gitSlot.decorate!(file('a.txt'), c)).toMatchObject({ badge: 'A' })
})

it('unmount: marks dibuang dan event berikutnya tak memuat lagi', async () => {
  h.status.mockResolvedValue(ok({ 'a.txt': 'M' }))
  const c = ctx()
  const { unmount } = renderHook(() => gitSlot.useSlot!(c))
  await flush()
  unmount()
  emitFsEvent({ kind: 'dirty', path: '/r', origin: 'remote' })
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(h.status).toHaveBeenCalledTimes(1)
  expect(gitSlot.decorate!(file('a.txt'), c)).toBeUndefined()
})

it('gagal git-status: dekorasi kosong, tidak melempar', async () => {
  h.status.mockResolvedValue({ ok: false, code: 'EIO', error: 'x' })
  const c = ctx()
  renderHook(() => gitSlot.useSlot!(c))
  await flush()
  expect(gitSlot.decorate!(file('a.txt'), c)).toBeUndefined()
})

it('conflict shows the VS Code `!` badge; ignored is colour-only, also for children of an ignored folder', async () => {
  h.status.mockResolvedValue(ok({ 'x.txt': 'C', merge: 'C', node_modules: 'I' }))
  const c = ctx()
  renderHook(() => gitSlot.useSlot!(c))
  await flush()
  expect(gitSlot.decorate!(file('x.txt'), c)).toEqual({ badge: '!', title: 'Conflict', className: 'files-git--C' })
  expect(gitSlot.decorate!(file('merge', true), c)).toEqual({ badge: '•', title: 'Contains conflicts', className: 'files-git--C' })
  expect(gitSlot.decorate!(file('node_modules', true), c)).toEqual({ title: 'Ignored', className: 'files-git--I' })
  expect(gitSlot.decorate!({ ...file('a.log'), ignored: true }, c)).toEqual({ title: 'Ignored', className: 'files-git--I' })
})

const branch = (over: Partial<GitBranch> = {}): GitBranch => ({ branch: 'main', head: '0123abcd', upstream: 'origin/main', ahead: 0, behind: 0, ...over })
const footerText = (c: FilesSlotCtx) => {
  const { container, unmount } = render(<>{gitSlot.footer!(c)}</>)
  const out = { text: container.textContent ?? '', titles: [...container.querySelectorAll('[title]')].map((e) => e.getAttribute('title')) }
  unmount()
  return out
}

it('footer: branch, VS Code sync label `behind↓ ahead↑` + tooltip, detached oid, hidden outside a repo', async () => {
  h.status.mockResolvedValueOnce(ok({}, branch()))
    .mockResolvedValueOnce(ok({}, branch({ ahead: 2, behind: 1 })))
    .mockResolvedValueOnce(ok({}, branch({ branch: null, upstream: null })))
    .mockResolvedValueOnce(ok({}))
  const c = ctx()
  renderHook(() => gitSlot.useSlot!(c))
  await flush()
  expect(footerText(c)).toEqual({ text: 'main', titles: ['main'] })
  const reload = async () => { emitFsEvent({ kind: 'dirty', path: '/r', origin: 'remote' }); await act(async () => { await vi.advanceTimersByTimeAsync(1000) }) }
  await reload()
  expect(footerText(c)).toEqual({ text: 'main1↓ 2↑', titles: ['main', 'Pull 1 and push 2 commits between origin/main'] })
  await reload()
  expect(footerText(c).text).toBe('0123abcd')
  await reload()
  expect(gitSlot.footer!(c)).toBe(null)
})

it('every gitDecoration token the slot CSS uses is defined in both VS Code theme files', () => {
  // Not `new URL(`./${f}`, import.meta.url)`: Vite rewrites that into a one-level glob and misses `vscode/`.
  const read = (f: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), f), 'utf8')
  const used = [...new Set(read('filesSlot.git.css').match(/--vscode-gitDecoration-[\w-]+/g))]
  expect(used).toContain('--vscode-gitDecoration-ignoredResourceForeground')
  for (const theme of ['vscode/vscode-theme.dark.css', 'vscode/vscode-theme.light.css']) {
    const css = read(theme)
    expect(used.filter((t) => !css.includes(`${t}:`))).toEqual([])
  }
})
