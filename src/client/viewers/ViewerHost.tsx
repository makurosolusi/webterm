// STUB(WS-FM-06): pemilih viewer per `fileKind` (gambar/PDF/audio/video). Sampai WS-06 hanya
// placeholder jujur, supaya pemanggil (EditorNode, WS-02 W2) sudah bisa memasangnya.
import type { FileKind } from '../../shared/fileKind'

export interface ViewerHostProps { path: string; kind: FileKind }

export function ViewerHost({ kind }: ViewerHostProps) {
  return <div role="note">Viewer untuk file {kind} belum tersedia.</div>
}
