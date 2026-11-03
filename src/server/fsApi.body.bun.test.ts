// Bun-only (api.ts menarik bun:sqlite lewat ./db). Regresi M-03: `data += chunk` membelah multibyte
// antar-chunk; body fs sekarang Buffer + cap FS_BODY_MAX (413 ETOOLARGE).
import { test, expect } from 'bun:test'
import http from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FS_BODY_MAX } from '../shared/fsLimits'

const dataDir = mkdtempSync(join(tmpdir(), 'wt-fsbody-'))
process.env.WEBTERM_DATA_DIR = dataDir // sebelum ./api -> ./db dibuka
const { handleApi } = await import('./api')

const server = http.createServer((req, res) => { if (!handleApi(req, res)) { res.statusCode = 404; res.end() } })
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const port = (server.address() as { port: number }).port

/** POST chunked; tiap elemen `chunks` jadi satu write terpisah dengan jeda, supaya tiba sebagai chunk sendiri. */
function post(path: string, chunks: Buffer[]): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', (e) => (e as NodeJS.ErrnoException).code === 'EPIPE' || (e as NodeJS.ErrnoException).code === 'ECONNRESET' ? resolve({ status: 413, body: '' }) : reject(e))
    ;(async () => {
      for (const c of chunks) { req.write(c); await new Promise((r) => setTimeout(r, 20)) }
      req.end()
    })()
  })
}

test('write: euro (3 byte) terbelah antar-chunk tersimpan utuh', async () => {
  const file = join(dataDir, 'euro.txt')
  const raw = Buffer.from(JSON.stringify({ path: file, content: 'a€b€c' }))
  const cut = raw.indexOf(Buffer.from('€')) + 1 // di tengah byte €
  const res = await post('/api/fs/write', [raw.subarray(0, cut), raw.subarray(cut)])
  expect(res.status).toBe(200)
  expect(readFileSync(file, 'utf8')).toBe('a€b€c')
})

test('write: body > FS_BODY_MAX -> 413 ETOOLARGE dan file tidak dibuat', async () => {
  const file = join(dataDir, 'huge.txt')
  const head = Buffer.from(`{"path":${JSON.stringify(file)},"content":"`)
  const res = await post('/api/fs/write', [head, Buffer.alloc(FS_BODY_MAX + 1024, 97), Buffer.from('"}')])
  expect(res.status).toBe(413)
  expect(res.body).toContain('ETOOLARGE')
  let exists = true
  try { readFileSync(file) } catch { exists = false }
  expect(exists).toBe(false)
})

test('akhir', () => { server.close() })
