// Navigasi dan pembukaan entri dari FilesNode: pindah folder, buka file di editor di sampingnya,
// dan simpul baru (terminal/editor). Dipisah dari shell supaya FilesNode tinggal kerangka + state.
import { useRef, type MutableRefObject } from 'react'
import type { Node } from '@xyflow/react'
import { useReactFlow } from '@xyflow/react'
import { childOnPath, childPath, fileOpenTarget, folderTitle } from './fileBrowse'
import { EDITOR_SIZE, planFileOpen } from './fileOpen'
import { rectOfNode, revealNode, selectOnly } from './nodeReveal'
import { ANCHOR_FALLBACK_SIZE, placeBeside } from './browser.open.place'
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
  // `rf.addNodes` antre sampai commit berikutnya: tanpa ini dua pembukaan beruntun tidak saling
  // melihat, jadi mendarat di titik yang sama atau melahirkan dua node untuk satu file.
  const justAdded = useRef<Node[]>([])

  /** Node canvas ditambah node yang sudah kita tambahkan tapi belum sampai di React Flow. */
  const liveNodes = (): Node[] => {
    const nodes = rf.getNodes()
    justAdded.current = justAdded.current.filter((a) => !nodes.some((n) => n.id === a.id))
    return [...nodes, ...justAdded.current]
  }

  const navigate = (to: string, cameFrom?: string) => {
    if (cameFrom) pendingSel.current = childOnPath(to, cameFrom)
    // Judul mengikuti folder hanya selama pengguna belum menamainya sendiri.
    const auto = !title || title === folderTitle(cwd)
    rf.updateNodeData(id, { dirPath: to, ...(auto ? { title: folderTitle(to) } : {}) })
  }

  const addNodeBeside = (
    nid: string, kind: 'terminal' | 'editor', extra: Record<string, unknown>, attrs?: Partial<Node>,
  ) => {
    const nodes = liveNodes()
    const me = nodes.find((n) => n.id === id)
    const position = placeBeside({
      anchor: me && rectOfNode(me),
      center: me?.position ?? { x: 0, y: 0 },
      occupied: nodes.map(rectOfNode),
      size: { width: attrs?.width ?? ANCHOR_FALLBACK_SIZE.width, height: attrs?.height ?? ANCHOR_FALLBACK_SIZE.height },
    })
    const node: Node = { id: nid, type: kind, position, ...attrs, data: { id: nid, kind, color: swatch, ...extra } }
    justAdded.current.push(node)
    rf.addNodes(node)
    return position
  }

  /**
   * Buka `p` di node editor-nya sendiri (file yang sudah terbuka cukup ditampilkan).
   * `focusEditor: false` (satu klik/Space): fokus keyboard + seleksi TETAP di Files supaya pengguna bisa
   * terus mengeklik; kamera pindah hanya bila editornya di luar layar, dan Files ikut tetap terlihat.
   * `focusEditor: true` (Enter/menu): editor dipilih dan menerima fokus.
   */
  const openFile = (p: string, { focusEditor }: { focusEditor: boolean }) => {
    const name = fileBaseName(p)
    // Tab browser tidak bisa menyerahkan file ke OS mesin server — katakan, jangan buka buffer sampah.
    if (fileOpenTarget(p) !== 'canvas') { setNotice(`${name} needs an application on the server to open.`); return }
    const nodes = liveNodes()
    const edges = [...rf.getEdges(), ...justAdded.current.map((n) => ({ source: id, target: n.id }))]
    const plan = planFileOpen(nodes, edges, id, p, randomId())
    const revealOpts = focusEditor ? { focus: true } : { focus: false, alongside: id }
    if (plan.focus) {
      // Buka = antar pengguna ke editornya, termasuk saat file sudah terbuka (mis. dari node files lain):
      // tanpa kamera + fokus, editor yang sudah ada di luar layar terasa "tidak terjadi apa-apa".
      if (focusEditor) selectOnly(rf, plan.nodeId)
      const hit = nodes.find((n) => n.id === plan.nodeId)
      if (hit) revealNode(rf, plan.nodeId, rectOfNode(hit), revealOpts)
    } else {
      const position = addNodeBeside(plan.nodeId, 'editor', { filePath: p, title: name }, EDITOR_SIZE)
      // Node baru belum ada di DOM sampai commit; rect-nya sudah diketahui dari posisi + EDITOR_SIZE.
      if (focusEditor) selectOnly(rf, plan.nodeId)
      requestAnimationFrame(() => revealNode(rf, plan.nodeId, { ...position, ...EDITOR_SIZE }, revealOpts))
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

  const open = (e: { name: string; dir: boolean }, opts = { focusEditor: true }) => {
    const p = childPath(cwd, e.name)
    if (e.dir) navigate(p)
    else openFile(p, opts)
  }

  return { navigate, addNodeBeside, open, openFile }
}
