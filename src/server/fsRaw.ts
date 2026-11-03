// STUB(WS-FM-06): `raw` (bytes + Range/ETag). Dispatcher mengembalikan `RawReply`; `sendRaw` dipanggil
// api.ts. Stub menjawab EDISABLED; WS-06 mengisi `serveRaw` dan boleh memperluas `sendRaw`.
import type { IncomingHttpHeaders } from 'node:http'
import type { ServerResponse } from 'node:http'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fsFail, type FsFail } from '../shared/fsContract'

export interface RawReply { status: number; headers: Record<string, string>; body?: Readable | Buffer }

/** Sajikan file mentah; `FsFail` bila tak bisa (dispatcher memetakan ke status). */
export async function serveRaw(_path: string, _reqHeaders: IncomingHttpHeaders): Promise<RawReply | FsFail> {
  return fsFail('EDISABLED', 'raw belum diimplementasi (WS-FM-06)')
}

/** Tulis `RawReply` ke `res`; body stream di-pipe, galat stream memutus koneksi. */
export async function sendRaw(res: ServerResponse, raw: RawReply): Promise<void> {
  res.statusCode = raw.status
  for (const [k, v] of Object.entries(raw.headers)) res.setHeader(k, v)
  if (raw.body === undefined || Buffer.isBuffer(raw.body)) { res.end(raw.body); return }
  await pipeline(raw.body, res)
}
