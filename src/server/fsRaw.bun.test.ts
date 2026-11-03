// `raw` terhadap filesystem NYATA dan HTTP nyata (node:http + sendRaw): rentang, ETag/304, header
// keamanan, penolakan path, flag VIEWERS lewat dispatcher. Bun-only (fs + socket).
import { test, expect } from 'bun:test'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import npath from 'node:path'
import { fsApiRoute } from './fsApi'
import { sendRaw, serveRaw, type RawReply } from './fsRaw'

async function withTmp(fn: (at: (...s: string[]) => string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(npath.join(tmpdir(), 'webterm-raw-'))
  try {
    await fn((...segs: string[]) => npath.join(root, ...segs))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

async function bytesOf(r: RawReply): Promise<Buffer> {
  if (!r.body) return Buffer.alloc(0)
  if (Buffer.isBuffer(r.body)) return r.body
  const parts: Buffer[] = []
  for await (const c of r.body) parts.push(c as Buffer)
  return Buffer.concat(parts)
}
async function ok(path: string, headers: Record<string, string> = {}, opts?: { download?: boolean }): Promise<RawReply> {
  const r = await serveRaw(path, headers, opts)
  if (!('status' in r)) throw new Error(`serveRaw failed: ${r.code}`)
  return r
}

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz'

test('full 200: streaming body, Content-Length, Accept-Ranges, Content-Type from fileKind, security headers', async () => {
  await withTmp(async (at) => {
    await fs.writeFile(at('pic.png'), DIGITS)
    const r = await ok(at('pic.png'))
    expect(r.status).toBe(200)
    expect(Buffer.isBuffer(r.body)).toBe(false) // stream, bukan Buffer penuh
    expect((await bytesOf(r)).toString()).toBe(DIGITS)
    expect(r.headers['Content-Type']).toBe('image/png')
    expect(r.headers['Content-Length']).toBe(String(DIGITS.length))
    expect(r.headers['Accept-Ranges']).toBe('bytes')
    expect(r.headers['X-Content-Type-Options']).toBe('nosniff')
    expect(r.headers['Referrer-Policy']).toBe('no-referrer')
    expect(r.headers['Cache-Control']).toBe('private, no-store')
    expect(r.headers['Content-Security-Policy']).toBe(undefined)
  })
})

test('Range: 0-9 -> 206 + Content-Range; open-ended; suffix; end clamped', async () => {
  await withTmp(async (at) => {
    await fs.writeFile(at('a.mp3'), DIGITS)
    const n = DIGITS.length
    const a = await ok(at('a.mp3'), { range: 'bytes=0-9' })
    expect(a.status).toBe(206)
    expect(a.headers['Content-Range']).toBe(`bytes 0-9/${n}`)
    expect(a.headers['Content-Length']).toBe('10')
    expect((await bytesOf(a)).toString()).toBe('0123456789')
    const b = await ok(at('a.mp3'), { range: 'bytes=30-' })
    expect((await bytesOf(b)).toString()).toBe('uvwxyz')
    const c = await ok(at('a.mp3'), { range: 'bytes=-4' })
    expect((await bytesOf(c)).toString()).toBe('wxyz')
    const d = await ok(at('a.mp3'), { range: 'bytes=30-9999' })
    expect(d.headers['Content-Range']).toBe(`bytes 30-${n - 1}/${n}`)
  })
})

test('invalid Range -> 416 with Content-Range */size (past EOF, reversed, garbage, multi-range, empty file)', async () => {
  await withTmp(async (at) => {
    await fs.writeFile(at('a.mp4'), DIGITS)
    await fs.writeFile(at('empty.mp4'), '')
    for (const range of ['bytes=99-', 'bytes=9-2', 'bytes=abc', 'bytes=0-1,3-4', 'bytes=-0', 'bytes=-']) {
      const r = await ok(at('a.mp4'), { range })
      expect(`${range} ${r.status}`).toBe(`${range} 416`)
      expect(r.headers['Content-Range']).toBe(`bytes */${DIGITS.length}`)
    }
    expect((await ok(at('empty.mp4'), { range: 'bytes=0-0' })).status).toBe(416)
    expect((await ok(at('empty.mp4'))).status).toBe(200)
    expect((await ok(at('a.mp4'), { range: 'items=1-2' })).status).toBe(200) // satuan asing diabaikan
  })
})

test('If-Range: stale validator ignores Range (full 200); matching keeps 206', async () => {
  await withTmp(async (at) => {
    await fs.writeFile(at('a.wav'), DIGITS)
    const etag = (await ok(at('a.wav'))).headers.ETag
    expect((await ok(at('a.wav'), { range: 'bytes=0-1', 'if-range': '"stale"' })).status).toBe(200)
    expect((await ok(at('a.wav'), { range: 'bytes=0-1', 'if-range': etag })).status).toBe(206)
  })
})

test('ETag = quoted FsVersion; If-None-Match -> 304 without body; changed file -> new ETag, 200', async () => {
  await withTmp(async (at) => {
    await fs.writeFile(at('a.gif'), 'one')
    const first = await ok(at('a.gif'))
    const etag = first.headers.ETag
    expect(/^"\d+-3"$/.test(etag)).toBe(true)
    const hit = await ok(at('a.gif'), { 'if-none-match': etag })
    expect(hit.status).toBe(304)
    expect(hit.body).toBe(undefined)
    expect(hit.headers['X-Content-Type-Options']).toBe('nosniff')
    expect((await ok(at('a.gif'), { 'if-none-match': `W/${etag}, "x"` })).status).toBe(304)
    expect((await ok(at('a.gif'), { 'if-none-match': '*' })).status).toBe(304)
    await fs.writeFile(at('a.gif'), 'three')
    const after = await ok(at('a.gif'), { 'if-none-match': etag })
    expect(after.status).toBe(200)
    expect(after.headers.ETag).not.toBe(etag)
  })
})

test('SVG/HTML get CSP sandbox + default-src none; unknown extension -> octet-stream (never sniffed)', async () => {
  await withTmp(async (at) => {
    await fs.writeFile(at('x.svg'), '<svg onload="alert(1)"/>')
    await fs.writeFile(at('x.html'), '<script>1</script>')
    await fs.writeFile(at('x.weird'), 'zzz')
    const svg = await ok(at('x.svg'))
    expect(svg.headers['Content-Type']).toBe('image/svg+xml')
    expect(svg.headers['Content-Security-Policy']).toBe("sandbox; default-src 'none'")
    const html = await ok(at('x.html'))
    expect(html.headers['Content-Security-Policy']).toBe("sandbox; default-src 'none'")
    expect(html.headers['Content-Type']).toBe('application/octet-stream')
    const weird = await ok(at('x.weird'))
    expect(weird.headers['Content-Type']).toBe('application/octet-stream')
    expect(weird.headers['X-Content-Type-Options']).toBe('nosniff')
  })
})

test('download=1 adds attachment with ASCII fallback + RFC 5987 name; absent by default', async () => {
  await withTmp(async (at) => {
    await fs.writeFile(at('lap"oran é.pdf'), 'x')
    const plain = await ok(at('lap"oran é.pdf'))
    expect(plain.headers['Content-Disposition']).toBe(undefined)
    const dl = await ok(at('lap"oran é.pdf'), {}, { download: true })
    expect(dl.headers['Content-Disposition']).toBe(`attachment; filename="lap_oran _.pdf"; filename*=UTF-8''lap%22oran%20%C3%A9.pdf`)
  })
})

test('rejects directory, missing file, relative path, NUL; leaves nothing open', async () => {
  await withTmp(async (at) => {
    await fs.mkdir(at('d.png'))
    const dir = await serveRaw(at('d.png'), {})
    expect('code' in dir && dir.code).toBe('EISDIR')
    const missing = await serveRaw(at('nope.png'), {})
    expect('code' in missing && missing.code).toBe('ENOENT')
    const rel = await serveRaw('../etc/passwd', {})
    expect('code' in rel && rel.code).toBe('EINVAL')
    const nul = await serveRaw(`${at('a.png')}\0.txt`, {})
    expect('code' in nul && nul.code).toBe('EINVAL')
    // `..` yang menormalisasi ke file nyata tetap file itu (resolveFsPath), bukan lolos ke tempat lain
    await fs.writeFile(at('real.png'), 'r')
    expect((await ok(at('d.png', '..', 'real.png'))).status).toBe(200)
  })
})

test('large file streams in a bounded range without reading it whole', async () => {
  await withTmp(async (at) => {
    const big = at('big.mp4')
    const fh = await fs.open(big, 'w')
    await fh.truncate(300 * 1024 * 1024) // sparse 300 MB: murah di disk, mustahil dimuat utuh tanpa terasa
    await fh.close()
    const r = await ok(big, { range: 'bytes=299999990-300000009' })
    expect(r.status).toBe(206)
    expect(r.headers['Content-Length']).toBe('20')
    expect((await bytesOf(r)).length).toBe(20)
  })
})

test('dispatcher: flag VIEWERS off -> 501 EDISABLED, on -> 200 raw; not-a-file -> 400', async () => {
  const prev = process.env.WEBTERM_FILES_VIEWERS
  try {
    await withTmp(async (at) => {
      await fs.writeFile(at('a.png'), 'png')
      const call = (p: string) => fsApiRoute('/api/fs/raw', 'GET', new URLSearchParams({ path: p }), () => Promise.resolve(''), { headers: {} })
      process.env.WEBTERM_FILES_VIEWERS = 'off' // default ON (L11): jalur mati butuh `off` eksplisit
      const off = await call(at('a.png'))
      expect(off?.status).toBe(501)
      process.env.WEBTERM_FILES_VIEWERS = 'on'
      const on = await call(at('a.png'))
      expect(on?.status).toBe(200)
      expect(on?.raw?.headers['Content-Type']).toBe('image/png')
      on?.raw?.body && !Buffer.isBuffer(on.raw.body) && on.raw.body.destroy()
      const dir = await call(at())
      expect(dir?.status).toBe(400)
    })
  } finally {
    if (prev === undefined) delete process.env.WEBTERM_FILES_VIEWERS
    else process.env.WEBTERM_FILES_VIEWERS = prev
  }
})

test('sendRaw over real HTTP: 206 body, 304 empty, and aborted client does not throw', async () => {
  await withTmp(async (at) => {
    await fs.writeFile(at('v.mp4'), DIGITS)
    const sent: Promise<void>[] = []
    const server = http.createServer((req, res) => {
      sent.push(serveRaw(at('v.mp4'), req.headers).then(async (r) => {
        if ('status' in r) await sendRaw(res, r)
        else res.writeHead(500).end()
      }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      const part = await fetch(`http://127.0.0.1:${port}/`, { headers: { Range: 'bytes=2-5' } })
      expect(part.status).toBe(206)
      expect(await part.text()).toBe('2345')
      const etag = part.headers.get('etag') ?? ''
      const nm = await fetch(`http://127.0.0.1:${port}/`, { headers: { 'If-None-Match': etag } })
      expect(nm.status).toBe(304)
      expect((await nm.text()).length).toBe(0)
      const ctl = new AbortController()
      const aborted = fetch(`http://127.0.0.1:${port}/`, { signal: ctl.signal }).catch(() => 'aborted')
      ctl.abort()
      await aborted
      await Promise.all(sent) // tidak ada rejection dari sendRaw
    } finally {
      server.close()
    }
  })
})
