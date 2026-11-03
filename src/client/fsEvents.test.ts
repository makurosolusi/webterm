import { afterEach, expect, it, vi } from 'vitest'
import { emitFsEvent, onFsEvent } from './fsEvents'

const ev = { kind: 'renamed', path: '/b', from: '/a', origin: 'local' } as const
const offs: (() => void)[] = []
afterEach(() => { offs.splice(0).forEach((o) => o()); vi.restoreAllMocks() })

it('emit mengirim ke semua pendengar; off berhenti mendengar', () => {
  const a = vi.fn(), b = vi.fn()
  offs.push(onFsEvent(a))
  const offB = onFsEvent(b)
  emitFsEvent(ev)
  offB()
  emitFsEvent(ev)
  expect(a).toHaveBeenCalledTimes(2)
  expect(b).toHaveBeenCalledTimes(1)
  expect(a).toHaveBeenCalledWith(ev)
})

it('pendengar yang melempar dicatat dan tidak menghentikan pendengar lain', () => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const ok = vi.fn()
  offs.push(onFsEvent(() => { throw new Error('boom') }), onFsEvent(ok))
  expect(() => emitFsEvent(ev)).not.toThrow()
  expect(ok).toHaveBeenCalledTimes(1)
  expect(err).toHaveBeenCalledWith(expect.stringContaining('renamed /b'), expect.any(Error))
})

it('unsubscribe saat emit tidak merusak iterasi', () => {
  const calls: string[] = []
  const off = onFsEvent(() => { calls.push('1'); off() })
  offs.push(onFsEvent(() => calls.push('2')))
  emitFsEvent(ev)
  expect(calls).toEqual(['1', '2'])
})
