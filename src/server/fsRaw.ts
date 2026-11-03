// Endpoint `raw` (PLAN/FILEMANAGER-b.md §5.2): bytes file untuk viewer (gambar/audio/video/PDF) dan
// download. File TIDAK dimuat ke memori: handle dibuka, `ETag` = `FsVersion` dari stat handle yang sama,
// body = stream (satu rentang bila `Range`). Query (token) tak pernah dicatat; log hanya basename.
import type { IncomingHttpHeaders, ServerResponse } from 'node:http'
import { createReadStream, promises as fs } from 'node:fs'
import npath from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fsFail, type FsFail } from '../shared/fsContract'
import { mimeOf } from '../shared/fileKind'
import { codeOf, failFrom, versionOf } from './fsAtomic'
import { checkFsPath } from './fsOps'
import { createLogger } from './logs'

const log = createLogger('fs')

export interface RawReply { status: number; headers: Record<string, string>; body?: Readable | Buffer }
/** Opsi per request: `download` = `Content-Disposition: attachment` (dari query `download=1`). */
export interface RawOpts { download?: boolean }

const FALLBACK_TYPE = 'application/octet-stream'
/** Dokumen aktif (SVG/HTML) boleh dibuka langsung di tab; sandbox + default-src 'none' mematikan skripnya. */
const ACTIVE_DOC_RE = /\.(svg|html?|xhtml)$/i
const RANGE_RE = /^bytes=(\d*)-(\d*)$/

type Range = { start: number; end: number } | 'invalid' | null

/** Parse `Range` satu rentang. `null` = abaikan (tak ada / satuan lain); `'invalid'` = 416 (cacat, multi-rentang, di luar file). */
function parseRange(header: string | undefined, size: number): Range {
  if (!header || !header.startsWith('bytes=')) return null
  const m = RANGE_RE.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid'
  if (m[1] === '') { // suffix: n byte terakhir
    const n = Number(m[2])
    return n > 0 && size > 0 ? { start: Math.max(0, size - n), end: size - 1 } : 'invalid'
  }
  const start = Number(m[1])
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  return start < size && start <= end ? { start, end } : 'invalid'
}

/** True bila `If-None-Match` memuat etag ini (atau `*`); `W/` diabaikan (perbandingan lemah, RFC 9110). */
function etagMatches(header: string | undefined, etag: string): boolean {
  return !!header && header.split(',').some((t) => { const v = t.trim().replace(/^W\//, ''); return v === '*' || v === etag })
}

/** `Content-Disposition: attachment` dengan nama ASCII aman + `filename*` RFC 5987 untuk nama aslinya. */
function attachment(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, '_')
  const pct = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${pct}`
}

/** Sajikan file mentah; `FsFail` bila tak bisa (dispatcher memetakan ke status). */
export async function serveRaw(path: string, reqHeaders: IncomingHttpHeaders, opts: RawOpts = {}): Promise<RawReply | FsFail> {
  const target = checkFsPath(path)
  if (typeof target !== 'string') return target
  const name = npath.basename(target)
  let fh: fs.FileHandle | undefined
  try {
    // stat dulu: open() pada FIFO menggantung; hanya file reguler yang disajikan.
    const pre = await fs.stat(target)
    if (!pre.isFile()) return fsFail(pre.isDirectory() ? 'EISDIR' : 'EINVAL', `raw failed: ${name} is not a regular file`)
    fh = await fs.open(target, 'r')
    const st = await fh.stat({ bigint: true })
    const size = Number(st.size)
    const etag = `"${versionOf(st)}"`
    const headers: Record<string, string> = {
      'Content-Type': mimeOf(name) ?? FALLBACK_TYPE,
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'private, no-store',
    }
    if (ACTIVE_DOC_RE.test(name)) headers['Content-Security-Policy'] = "sandbox; default-src 'none'"
    if (opts.download) headers['Content-Disposition'] = attachment(name)

    if (etagMatches(reqHeaders['if-none-match'], etag)) return { status: 304, headers }
    const ifRange = reqHeaders['if-range']
    const range = ifRange && ifRange !== etag ? null : parseRange(reqHeaders.range, size)
    if (range === 'invalid') return { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } }
    if (size === 0) return { status: 200, headers: { ...headers, 'Content-Length': '0' }, body: Buffer.alloc(0) }

    const { start, end } = range ?? { start: 0, end: size - 1 }
    // Handle ditutup di `finally`; stream membuka ulang lewat path (rentang sama, EACCES sudah teruji di open di atas).
    const body = createReadStream(target, { start, end })
    headers['Content-Length'] = String(end - start + 1)
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
    return { status: range ? 206 : 200, headers, body }
  } catch (err) {
    return failFrom('raw', target, err)
  } finally {
    await fh?.close()
  }
}

/** Tulis `RawReply` ke `res`; body stream di-pipe. Klien memutus (seek media, tab ditutup) = normal; galat lain memutus koneksi. */
export async function sendRaw(res: ServerResponse, raw: RawReply): Promise<void> {
  res.statusCode = raw.status
  for (const [k, v] of Object.entries(raw.headers)) res.setHeader(k, v)
  if (raw.body === undefined || Buffer.isBuffer(raw.body)) { res.end(raw.body); return }
  try {
    await pipeline(raw.body, res)
  } catch (err) {
    if (res.destroyed || (err as { code?: string }).code === 'ERR_STREAM_PREMATURE_CLOSE') return // klien yang pergi
    log.warn('fs.error', 'raw stream failed', { code: codeOf(err) })
    res.destroy(err as Error)
  }
}
