// STUB(WS-FM-10): `upload` (stream ke tmp lalu rename, cap `maxBytes`). Dikunci flag UPLOAD.
import type { Readable } from 'node:stream'
import { fsFail, type FsResult } from '../shared/fsContract'

export async function uploadFile(_dir: string, _name: string, _stream: Readable | undefined, _maxBytes: number): Promise<FsResult> {
  return fsFail('EDISABLED', 'upload belum diimplementasi (WS-FM-10)')
}
