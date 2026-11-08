// Navigasi dan pembukaan entri dari FilesNode: pindah folder, buka file di editor di sampingnya,
// dan simpul baru (terminal/editor). Dipisah dari shell supaya FilesNode tinggal kerangka + state.
import type { MutableRefObject } from 'react'
import type { Node } from '@xyflow/react'
import { useReactFlow } from '@xyflow/react'
import { childOnPath, childPath, fileOpenTarget, folderTitle } from './fileBrowse'
import { EDITOR_SIZE, planFileOpen } from './fileOpen'
import { rectOfNode, revealNode, selectOnly } from './nodeReveal'
import type { Rect } from './browser.open.place'
import { fileBaseName } from './editorFile'
import { randomId } from './randomId'

interface Args {
  id: string
  cwd: string
  title?: string
  swatch: string
  setNotice: (s: string) => void
  /** Nama yang harus terpilih begitu listing berikutnya mendarat (naik: folder yang baru ditinggalkan). */
  pendingSel: MutableRefObject<string | null>
}

export function useFilesOpen({ id, cwd, title, swatch, setNotice, pendingSel }: Args) {
  const rf = useReactFlow()

  const navigate = (to: string, cameFrom?: string) => {
    if (cameFrom) pendingSel.current = childOnPath(to, cameFrom)
    // Judul mengikuti folder hanya selama pengguna belum menamainya sendiri.
    const auto = !title || title === folderTitle(cwd)
    rf.updateNodeData(id, { dirPath: to, ...(auto ? { title: folderTitle(to) } : {}) })
  }

  const addNodeBeside = (
    nid: string, kind: 'terminal' | 'editor', extra: Record<string, unknown>, attrs?: Partial<Node>,
  ) => {
    const me = rf.getNode(id)
    const position = { x: (me?.position.x ?? 0) + (me?.measured?.width ?? 420) + 32, y: me?.position.y ?? 0 }
    rf.addNodes({ id: nid, type: kind, position, ...attrs, data: { id: nid, kind, color: swatch, ...extra } })
    return position
  }

  /**
   * Buka `p` di editor. `preview: true` (satu klik, VS Code): pakai ulang editor preview milik node ini
   * bila ada, dan fokus keyboard + seleksi TETAP di Files — kamera pindah hanya bila editornya di luar
   * layar. `preview: false` (Enter/menu): editor di-pin, dipilih, dan menerima fokus seperti sebelumnya.
   */
  const openFile = (p: string, { preview }: { preview: boolean }) => {
    const name = fileBaseName(p)
    // Tab browser tidak bisa menyerahkan file ke OS mesin server — katakan, jangan buka buffer sampah.
    if (fileOpenTarget(p) !== 'canvas') { setNotice(`${name} needs an application on the server to open.`); return }
    const plan = planFileOpen(rf.getNodes(), rf.getEdges(), id, p, randomId(), preview)
    const reveal = (rect: Rect) => {
      // Buka = antar pengguna ke editornya, termasuk saat file sudah terbuka (mis. dari node files lain):
      // tanpa kamera + fokus, editor yang sudah ada di luar layar terasa "tidak terjadi apa-apa".
      if (!preview) selectOnly(rf, plan.nodeId)
      revealNode(rf, plan.nodeId, rect, { focus: !preview })
    }
    const hit = rf.getNode(plan.nodeId)
    if (plan.focus || plan.swap) {
      if (plan.swap) {
        // `openSeq` menyuruh `useEditorFile` membaca ulang: path saja tidak cukup, karena rename juga
        // mengganti path dan justru harus MEMPERTAHANKAN buffer.
        const seq = ((hit?.data as { openSeq?: number } | undefined)?.openSeq ?? 0) + 1
        rf.updateNodeData(plan.nodeId, { filePath: p, title: name, openSeq: seq })
      } else if (!preview && (hit?.data as { preview?: boolean } | undefined)?.preview) {
        rf.updateNodeData(plan.nodeId, { preview: undefined })
      }
      if (hit) reveal(rectOfNode(hit))
    } else {
      const position = addNodeBeside(plan.nodeId, 'editor', { filePath: p, title: name, ...(preview ? { preview: true } : {}) }, EDITOR_SIZE)
      // Node baru belum ada di DOM sampai commit; rect-nya sudah diketahui dari posisi + EDITOR_SIZE.
      if (!preview) selectOnly(rf, plan.nodeId)
      requestAnimationFrame(() => revealNode(rf, plan.nodeId, { ...position, ...EDITOR_SIZE }, { focus: !preview }))
    }
    // Kabel penanda "file ini sedang terbuka". Dibuat langsung, BUKAN lewat `onConnect`: `canLink`
    // hanya meloloskan pasangan agent context-capable.
    // `kind` WAJIB masuk ke `data`, bukan level atas: itu satu-satunya tempat yang dibaca
    // `decorateEdges` (label "↔ open") dan `toBridge` (persistensi). Di level atas React Flow
    // menyimpannya tanpa keluhan, lalu kabelnya tampil "⇄ context" dan tersimpan sebagai context.
    if (plan.edge) {
      const { kind: edgeKind, ...edge } = plan.edge
      rf.addEdges({ ...edge, type: 'context', data: { kind: edgeKind } })
    }
  }

  const open = (e: { name: string; dir: boolean }, opts = { preview: false }) => {
    const p = childPath(cwd, e.name)
    if (e.dir) navigate(p)
    else openFile(p, opts)
  }

  return { navigate, addNodeBeside, open, openFile }
}
