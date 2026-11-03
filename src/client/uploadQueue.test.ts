import { afterEach, describe, expect, it, vi } from 'vitest'
import { fsFail, type FsEvent, type FsResult } from '../shared/fsContract'
import { onFsEvent } from './fsEvents'
import { UPLOAD_MSG, downloadUrl, uploadErrorText, uploadFiles, xhrUpload, type UploadSender } from './uploadQueue'

const file = (name: string, body = 'x') => new File([body], name)

afterEach(() => { vi.unstubAllGlobals() })

describe('uploadFiles', () => {
  it('berurutan (tak pernah dua sekaligus), progres per file, event created per sukses', async () => {
    let active = 0
    let maxActive = 0
    const order: string[] = []
    const send: UploadSender = async (_d, name, _f, onProgress) => {
      active++; maxActive = Math.max(maxActive, active); order.push(name)
      onProgress(5, 10); onProgress(10, 10)
      await Promise.resolve()
      active--
      return { ok: true }
    }
    const events: FsEvent[] = []
    const off = onFsEvent((e) => events.push(e))
    const prog: string[] = []
    const s = await uploadFiles('/d', [file('a'), file('b'), file('c')], { onProgress: (i, l, t) => prog.push(`${i}:${l}/${t}`) }, send)
    off()
    expect(order).toEqual(['a', 'b', 'c'])
    expect(maxActive).toBe(1)
    expect(prog).toEqual(['0:5/10', '0:10/10', '1:5/10', '1:10/10', '2:5/10', '2:10/10'])
    expect(s.ok).toEqual(['a', 'b', 'c'])
    expect(events.map((e) => `${e.kind} ${e.path} ${e.origin}`)).toEqual(['created /d/a local', 'created /d/b local', 'created /d/c local'])
  })

  it('galat satu file tidak menghentikan sisanya; ringkasan memuat pesan Indonesia; tanpa event untuk yang gagal', async () => {
    const send: UploadSender = async (_d, name): Promise<FsResult> => (name === 'b' ? fsFail('EEXIST', 'x') : { ok: true })
    const events: FsEvent[] = []
    const off = onFsEvent((e) => events.push(e))
    const done: string[] = []
    const s = await uploadFiles('/d/', [file('a'), file('b'), file('c')], { onFileDone: (_i, n, r) => done.push(`${n}:${r.ok}`) }, send)
    off()
    expect(done).toEqual(['a:true', 'b:false', 'c:true'])
    expect(s.ok).toEqual(['a', 'c'])
    expect(s.failed).toEqual([{ name: 'b', code: 'EEXIST', message: `b: ${UPLOAD_MSG.EEXIST}` }])
    expect(events.map((e) => e.path)).toEqual(['/d/a', '/d/c'])
  })

  it('daftar kosong: tidak ada request', async () => {
    const send = vi.fn()
    expect(await uploadFiles('/d', [], {}, send)).toEqual({ ok: [], failed: [] })
    expect(send).not.toHaveBeenCalled()
  })
})

describe('pesan & URL', () => {
  it('kode tak terdaftar jatuh ke pesan EIO', () => {
    expect(uploadErrorText('f', fsFail('EBINARY', 'x'))).toBe(`f: ${UPLOAD_MSG.EIO}`)
    expect(uploadErrorText('f', fsFail('ETOOLARGE', 'x'))).toBe(`f: ${UPLOAD_MSG.ETOOLARGE}`)
  })
  it('downloadUrl = raw + download=1, path ter-encode', () => {
    const u = new URL(downloadUrl('/a b/c#d.txt'), 'http://x')
    expect(u.pathname).toBe('/api/fs/raw')
    expect(u.searchParams.get('path')).toBe('/a b/c#d.txt')
    expect(u.searchParams.get('download')).toBe('1')
  })
})

describe('xhrUpload', () => {
  class FakeXhr {
    static last: FakeXhr
    static reply: { status: number; text: string } | 'error' = { status: 200, text: '{"ok":true}' }
    upload: { onprogress?: (e: unknown) => void } = {}
    onload?: () => void; onerror?: () => void; onabort?: () => void
    status = 0; responseText = ''
    method = ''; url = ''; sent: unknown
    open(m: string, u: string) { this.method = m; this.url = u; FakeXhr.last = this }
    send(b: unknown) {
      this.sent = b
      this.upload.onprogress?.({ lengthComputable: true, loaded: 3, total: 6 })
      if (FakeXhr.reply === 'error') { this.onerror?.(); return }
      this.status = FakeXhr.reply.status; this.responseText = FakeXhr.reply.text; this.onload?.()
    }
  }
  const run = (name = 'a b.txt') => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const seen: string[] = []
    const blob = new Blob(['abcdef'])
    return xhrUpload('/d', name, blob, (l, t) => seen.push(`${l}/${t}`)).then((r) => ({ r, seen, blob }))
  }

  it('POST ke /api/fs/upload dengan dir+name di query, body = file mentah, progres diteruskan', async () => {
    FakeXhr.reply = { status: 200, text: '{"ok":true}' }
    const { r, seen, blob } = await run()
    expect(r.ok).toBe(true)
    expect(seen).toEqual(['3/6'])
    expect(FakeXhr.last.method).toBe('POST')
    const u = new URL(FakeXhr.last.url, 'http://x')
    expect(u.pathname).toBe('/api/fs/upload')
    expect(u.searchParams.get('dir')).toBe('/d')
    expect(u.searchParams.get('name')).toBe('a b.txt')
    expect(FakeXhr.last.sent).toBe(blob)
  })
  it('FsFail server diteruskan; body non-JSON dan jaringan mati jadi EIO', async () => {
    FakeXhr.reply = { status: 409, text: '{"ok":false,"code":"EEXIST","error":"e"}' }
    expect(((await run()).r as { code: string }).code).toBe('EEXIST')
    FakeXhr.reply = { status: 502, text: '<html>bad gateway</html>' }
    const bad = (await run()).r
    expect(bad.ok === false && bad.code === 'EIO' && bad.error.includes('502')).toBe(true)
    FakeXhr.reply = 'error'
    expect(((await run()).r as { code: string }).code).toBe('EIO')
  })
})
