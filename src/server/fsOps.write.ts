// STUB(WS-FM-01): perilaku legacy di balik tanda tangan final. WS-01 mengganti isi (wx eksklusif,
// versi + tulis atomik, `created` sungguhan) TANPA mengubah tanda tangan; dispatcher tak disentuh.
import { fsFail, type FsResult } from '../shared/fsContract'
import { makeDir, pathExists, writeText } from './fsOps'

export interface WriteOpts { expectedVersion?: string; mustExist?: boolean }

/** Tulis teks; stub = `writeText` lama (belum cek versi/mustExist), `version` kosong. */
export async function writeFileChecked(path: string, content: string, _opts: WriteOpts = {}): Promise<FsResult> {
  return (await writeText(path, content)) ? { ok: true, version: '' } : fsFail('EIO', 'write failed')
}

/** Buat file baru; stub = cek `exists` lalu tulis (ada race, WS-01 menggantinya dengan `wx`). */
export async function createFileExclusive(path: string, content = ''): Promise<FsResult> {
  if (await pathExists(path)) return fsFail('EEXIST', 'already exists')
  return writeFileChecked(path, content)
}

/** `mkdir -p` dengan `created` (false bila sudah ada). */
export async function makeDirChecked(path: string): Promise<FsResult<{ created: boolean }>> {
  const existed = await pathExists(path)
  return (await makeDir(path)) ? { ok: true, created: !existed } : fsFail('EIO', 'mkdir failed')
}
