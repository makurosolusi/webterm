// STUB(WS-FM-04): penyimpanan trash di bawah `<WEBTERM_DATA_DIR>/trash/<id>/`. Diisi WS-04.
import { join } from 'node:path'
import { dataDir } from './config'

/** Akar trash; belum dipakai sampai WS-04. */
export function trashRoot(): string {
  return join(dataDir(), 'trash')
}
