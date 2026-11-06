import { afterEach, describe, expect, it, vi } from 'vitest'
import { fsFail, type FsEvent, type FsResult } from '../shared/fsContract'
import { onFsEvent } from './fsEvents'
import {
  KEEP_BOTH_TRIES, UPLOAD_MSG, createUploadQueue, downloadUrl, uploadErrorText, xhrUpload,
  type ConflictAnswer, type ConflictAsk, type UploadOutcome, type UploadProgress, type UploadSender,
} from './uploadQueue'

const file = (name: string, body = 'x') => new File([body], name)

afterEach(() => { vi.unstubAllGlobals() })

type Reply = FsResult | Promise<FsResult>
/** Records each send as `name[+ow]` and answers from `reply`. */
function harness(reply: (name: string, overwrite: boolean) => Reply, answers: ConflictAnswer[] = []) {
  const sent: string[] = []
  const asked: ConflictAsk[] = []
  const prog: UploadProgress[] = []
  const done: UploadOutcome[] = []
  const send: UploadSender = async (_d, name, _f, onProgress, opts) => {
    sent.push(`${name}${opts?.overwrite ? '+ow' : ''}`)
    onProgress(1, 2)
    return reply(name, !!opts?.overwrite)
  }
  const q = createUploadQueue({
    onProgress: (p) => prog.push(p),
    ask: async (c) => { asked.push(c); return answers.shift() ?? { choice: 'skip', all: false } },
    onDone: (o) => done.push(o),
  }, send)
  const idle = async () => { for (let i = 0; i < 50 && q.running; i++) await new Promise((r) => setTimeout(r, 0)) }
  return { q, sent, asked, prog, done, idle }
}
const OK: FsResult = { ok: true }
const EEXIST = fsFail('EEXIST', 'exists')
const job = (name: string, body = 'xx', dir = '/d') => ({ dir, file: file(name, body) })

describe('createUploadQueue', () => {
  it('runs one file at a time in FIFO order and emits a created event per success', async () => {
    let active = 0
    let maxActive = 0
    const h = harness(async () => { active++; maxActive = Math.max(maxActive, active); await Promise.resolve(); active--; return OK })
    const events: FsEvent[] = []
    const off = onFsEvent((e) => events.push(e))
    h.q.add([job('a'), job('b'), job('c')])
    await h.idle()
    off()
    expect(h.sent).toEqual(['a', 'b', 'c'])
    expect(maxActive).toBe(1)
    expect(h.done).toEqual([{ ok: ['a', 'b', 'c'], skipped: [], failed: [], cancelled: false }])
    expect(events.map((e) => `${e.kind} ${e.path} ${e.origin}`)).toEqual(['created /d/a local', 'created /d/b local', 'created /d/c local'])
  })

  it('jobs added while a batch runs join that batch instead of being rejected', async () => {
    let release: (r: FsResult) => void = () => {}
    const h = harness((name) => (name === 'a' ? new Promise<FsResult>((r) => { release = r }) : OK))
    h.q.add([job('a')])
    await Promise.resolve()
    expect(h.q.running).toBe(true)
    h.q.add([job('b')])
    release(OK)
    await h.idle()
    expect(h.sent).toEqual(['a', 'b'])
    expect(h.done).toHaveLength(1)
    expect(h.done[0].ok).toEqual(['a', 'b'])
    expect(h.prog.at(-1)).toMatchObject({ index: 2, total: 2, name: 'b' })
  })

  it('reports byte progress over the whole batch', async () => {
    const h = harness(() => OK)
    h.q.add([job('a', 'xx'), job('b', 'xx')])
    await h.idle()
    // tick(0) then the sender's onProgress(1, 2) for each file; bytes = 4 for the batch.
    expect(h.prog.map((p) => `${p.index}/${p.total} ${p.loaded}/${p.bytes}`)).toEqual(['1/2 0/4', '1/2 1/4', '2/2 2/4', '2/2 3/4'])
  })

  it('a failed file does not stop the rest; the failure keeps its job for Retry', async () => {
    const h = harness((name) => (name === 'b' ? fsFail('ETOOLARGE', 'big') : OK))
    const b = job('b')
    h.q.add([job('a'), b, job('c')])
    await h.idle()
    expect(h.done[0].ok).toEqual(['a', 'c'])
    expect(h.done[0].failed).toEqual([{ job: b, code: 'ETOOLARGE', message: `b: ${UPLOAD_MSG.ETOOLARGE}` }])
  })

  it('EEXIST + Replace re-sends the same name with overwrite', async () => {
    const h = harness((_n, ow) => (ow ? OK : EEXIST), [{ choice: 'replace', all: false }])
    h.q.add([job('a.txt')])
    await h.idle()
    expect(h.asked).toEqual([{ name: 'a.txt', dir: '/d', remaining: 0 }])
    expect(h.sent).toEqual(['a.txt', 'a.txt+ow'])
    expect(h.done[0].ok).toEqual(['a.txt'])
  })

  it('EEXIST + Keep Both tries VS Code copy names until one is free', async () => {
    const taken = new Set(['a.txt', 'a copy.txt'])
    const h = harness((n) => (taken.has(n) ? EEXIST : OK), [{ choice: 'keep', all: false }])
    h.q.add([job('a.txt')])
    await h.idle()
    expect(h.sent).toEqual(['a.txt', 'a copy.txt', 'a copy 2.txt'])
    expect(h.done[0].ok).toEqual(['a copy 2.txt'])
  })

  it('Keep Both gives up after KEEP_BOTH_TRIES names and reports EEXIST', async () => {
    const h = harness(() => EEXIST, [{ choice: 'keep', all: false }])
    h.q.add([job('a.txt')])
    await h.idle()
    expect(h.sent).toHaveLength(1 + KEEP_BOTH_TRIES)
    expect(h.done[0].failed[0].code).toBe('EEXIST')
  })

  it('EEXIST + Skip records the file as skipped, nothing overwritten', async () => {
    const h = harness(() => EEXIST, [{ choice: 'skip', all: false }])
    h.q.add([job('a.txt')])
    await h.idle()
    expect(h.sent).toEqual(['a.txt'])
    expect(h.done[0]).toEqual({ ok: [], skipped: ['a.txt'], failed: [], cancelled: false })
  })

  it('"apply to all" answers every later conflict of the batch without asking again', async () => {
    const h = harness((_n, ow) => (ow ? OK : EEXIST), [{ choice: 'replace', all: true }])
    h.q.add([job('a'), job('b'), job('c')])
    await h.idle()
    expect(h.asked.map((a) => `${a.name}:${a.remaining}`)).toEqual(['a:2'])
    expect(h.sent).toEqual(['a', 'a+ow', 'b', 'b+ow', 'c', 'c+ow'])
    expect(h.done[0].ok).toEqual(['a', 'b', 'c'])
  })

  it('cancel aborts the running request and drops the rest of the queue', async () => {
    let signal: AbortSignal | undefined
    const sent: string[] = []
    const done: UploadOutcome[] = []
    const send: UploadSender = (_d, name, _f, _p, opts) => {
      sent.push(name); signal = opts?.signal
      return new Promise((r) => opts?.signal?.addEventListener('abort', () => r(fsFail('EIO', 'aborted'))))
    }
    const q = createUploadQueue({ onProgress: () => {}, ask: async () => ({ choice: 'skip', all: false }), onDone: (o) => done.push(o) }, send)
    q.add([job('a'), job('b')])
    await Promise.resolve()
    q.cancel()
    for (let i = 0; i < 10 && q.running; i++) await new Promise((r) => setTimeout(r, 0))
    expect(signal?.aborted).toBe(true)
    expect(sent).toEqual(['a'])
    expect(done).toEqual([{ ok: [], skipped: [], failed: [], cancelled: true }])
  })

  it('an empty add sends nothing', () => {
    const h = harness(() => OK)
    h.q.add([])
    expect(h.q.running).toBe(false)
    expect(h.sent).toEqual([])
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
  it('overwrite adds overwrite=1 to the query; without it the flag is absent', async () => {
    FakeXhr.reply = { status: 200, text: '{"ok":true}' }
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    await xhrUpload('/d', 'a', new Blob(['x']), () => {}, { overwrite: true })
    expect(new URL(FakeXhr.last.url, 'http://x').searchParams.get('overwrite')).toBe('1')
    await run()
    expect(new URL(FakeXhr.last.url, 'http://x').searchParams.has('overwrite')).toBe(false)
  })
  it('an aborted signal aborts the request and resolves EIO naming the file', async () => {
    class HangXhr extends FakeXhr { aborted = false; send() {} abort() { this.aborted = true; this.onabort?.() } }
    vi.stubGlobal('XMLHttpRequest', HangXhr)
    const ac = new AbortController()
    const p = xhrUpload('/d', 'big.bin', new Blob(['x']), () => {}, { signal: ac.signal })
    ac.abort()
    const r = await p
    expect((FakeXhr.last as HangXhr).aborted).toBe(true)
    expect(r.ok === false && r.code === 'EIO' && r.error).toBe('fs upload big.bin: aborted')
    const pre = await xhrUpload('/d', 'late.bin', new Blob(['x']), () => {}, { signal: ac.signal })
    expect(pre.ok === false && pre.error).toBe('fs upload late.bin: aborted')
  })
})
