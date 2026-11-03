// Operasi mutasi (fsClient dipalsukan) + peta galat -> kalimat Indonesia.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FsErrCode, FsEvent } from '../shared/fsContract'

const fs = vi.hoisted(() => ({ remove: vi.fn(), restore: vi.fn(), rename: vi.fn(), copy: vi.fn() }))
vi.mock('./fsClient', () => fs)

import { deleteMany, duplicateMany, renameOne, restoreMany } from './filesMutate'
import { failReason, failText } from './filesMessages'
import { onFsEvent } from './fsEvents'

const fail = (code: FsErrCode, error = code) => Promise.resolve({ ok: false as const, code, error })
const events: FsEvent[] = []
const off = onFsEvent((e) => events.push(e))
afterEach(() => { events.length = 0; Object.values(fs).forEach((m) => m.mockReset()) })
// (off dibiarkan: listener hidup selama berkas tes)
void off

describe('filesMutate', () => {
  it('deleteMany: sekuensial, gagal tidak menghentikan sisanya, trashId dikumpulkan, event hanya untuk sukses', async () => {
    fs.remove.mockResolvedValueOnce({ ok: true, trashId: 't1' }).mockReturnValueOnce(fail('EACCES')).mockResolvedValueOnce({ ok: true, trashId: 't3' })
    const r = await deleteMany('/d', ['a', 'b', 'c'], false)
    expect(r.done).toEqual(['a', 'c'])
    expect(r.failed.map((f) => [f.name, f.fail.code])).toEqual([['b', 'EACCES']])
    expect(r.trashed).toEqual([{ name: 'a', trashId: 't1' }, { name: 'c', trashId: 't3' }])
    expect(events.map((e) => e.path)).toEqual(['/d/a', '/d/c'])
  })

  it('deleteMany permanen: tidak ada trashed (tak bisa di-Undo)', async () => {
    fs.remove.mockResolvedValue({ ok: true, trashId: 'ignored' })
    expect((await deleteMany('/d', ['a'], true)).trashed).toEqual([])
    expect(fs.remove).toHaveBeenCalledWith('/d/a', true)
  })

  it('restoreMany: mengembalikan path dan emit created', async () => {
    fs.restore.mockResolvedValue({ ok: true, path: '/d/a' })
    expect((await restoreMany([{ name: 'a', trashId: 't1' }])).paths).toEqual(['/d/a'])
    expect(events).toEqual([{ kind: 'created', path: '/d/a', origin: 'local' }])
  })

  it('duplicateMany: EEXIST (balapan) mencoba nama berikutnya; galat lain berhenti', async () => {
    fs.copy.mockReturnValueOnce(fail('EEXIST')).mockResolvedValueOnce({ ok: true })
    const r = await duplicateMany('/d', ['a.txt'], ['a.txt'])
    expect(fs.copy.mock.calls.map((c) => c[1])).toEqual(['/d/a copy.txt', '/d/a copy 2.txt'])
    expect(r.created).toEqual(['a copy 2.txt'])
    fs.copy.mockReset().mockReturnValue(fail('ENOSPC'))
    const r2 = await duplicateMany('/d', ['a.txt'], ['a.txt'])
    expect(fs.copy).toHaveBeenCalledTimes(1)
    expect(r2.failed[0].fail.code).toBe('ENOSPC')
  })

  it('renameOne: tanpa overwrite; gagal tidak emit', async () => {
    fs.rename.mockReturnValue(fail('EEXIST'))
    const r = await renameOne('/d', 'a', 'b')
    expect(fs.rename).toHaveBeenCalledWith('/d/a', '/d/b', false)
    expect(r.failed).toHaveLength(1)
    expect(events).toEqual([])
  })
})

describe('filesMessages', () => {
  const codes: FsErrCode[] = ['ENOENT', 'EEXIST', 'EACCES', 'EISDIR', 'ENOTDIR', 'EINVAL', 'ENAMETOOLONG', 'ENOSPC', 'EROFS', 'ENOTEMPTY', 'EXDEV', 'EVERSION', 'ETOOLARGE', 'EBINARY', 'EDISABLED', 'EIO']
  it.each(codes)('%s punya kalimat Indonesia, bukan kode mentah', (code) => {
    const t = failReason({ code, error: `${code}: raw` }, 'x')
    expect(t.length).toBeGreaterThan(10)
    expect(t).not.toContain(code)
  })
  it('401 (EIO "HTTP 401") dikenali sebagai sesi ditolak', () => {
    expect(failReason({ code: 'EIO', error: 'HTTP 401' }, 'x')).toContain('401')
  })
  it('restore + EEXIST bermakna tempat asal terisi; rename EEXIST menyebut nama tujuan', () => {
    expect(failText('restore', 'a', { code: 'EEXIST', error: 'e' })).toContain('Tempat asalnya sudah terisi')
    expect(failText('rename', 'a', { code: 'EEXIST', error: 'e' }, 'b')).toBe('Gagal mengganti nama “a”. Nama “b” sudah dipakai di folder ini.')
  })
})
