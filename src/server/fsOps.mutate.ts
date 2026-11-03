// STUB(WS-FM-04): delete/restore/rename/copy. Dikunci flag MUTATE oleh dispatcher; stub menjawab
// EDISABLED supaya flag yang dinyalakan sebelum WS-04 selesai gagal jujur, bukan diam.
import { fsFail, type FsResult } from '../shared/fsContract'

const NOT_READY = fsFail('EDISABLED', 'mutation belum diimplementasi (WS-FM-04)')

export async function deleteEntry(_path: string, _opts: { permanent?: boolean }): Promise<FsResult<{ trashId?: string }>> { return NOT_READY }
export async function restoreEntry(_trashId: string): Promise<FsResult<{ path: string }>> { return NOT_READY }
export async function renameEntry(_from: string, _to: string, _opts: { overwrite?: boolean }): Promise<FsResult> { return NOT_READY }
export async function copyEntry(_from: string, _to: string): Promise<FsResult> { return NOT_READY }
