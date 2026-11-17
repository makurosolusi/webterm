// Penyambung menu konteks canvas ke App: state "menu sedang terbuka di mana", handler klik kanan
// pane, dan pengikatan tiap baris menu ke aksi App yang sesungguhnya.
//
// KENAPA BUKAN DI App.tsx. App.tsx sudah 19.930 karakter saat wiring ini ditulis, 70 karakter di
// bawah hard limit 20.000 (Rule 8) — menaruhnya di sana melanggar batas itu seketika. Jadi yang
// dipindah ke sini adalah SELURUH concern-nya, bukan sekadar potongan terpanjangnya: satu hook yang
// App pakai dalam dua baris.
//
// Pembagian kerjanya tetap seperti sebelumnya: isi menu = data murni (`canvasMenu.model.ts`),
// matematika penempatan = fungsi murni (`canvasMenu.geometry.ts`), file ini cuma yang menyambung.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode, RefObject } from 'react'
import type { ReactFlowInstance, XYPosition } from '@xyflow/react'
import CanvasContextMenu from './CanvasContextMenu'
import { CapabilityOffer } from './CapabilityOffer'
import { resetBrowserStatusCache } from './browser.feature'
import { VscodePopover } from './components/vscode/vscodePopover'
import { buildCanvasMenuRows } from './canvasMenu.model'
import { HandleMenuView } from './handleMenu.view'
import { useSkillEntries } from './skillNode.entries'
import type { SkillRef } from './skillNode.add'
import { SN } from './skillNode.labels'
import type { AgentId } from '../shared/workspace'
import type { Settings } from '../shared/settings'

/** Aksi yang DIMILIKI App; hook ini tidak membuat node sendiri, ia cuma mengikat koordinatnya. */
export interface CanvasPaneMenuDeps {
  /** Dibaca saat klik, bukan saat hook dibuat: instance-nya baru ada setelah `onInit` React Flow. */
  rf: RefObject<ReactFlowInstance | null>
  settings: Pick<Settings, 'disabledAgents' | 'customAgents' | 'agentLaunchCommands'>
  nodeCount: number
  onAddTerminal: (at?: XYPosition) => void
  onAddFiles: (at?: XYPosition) => void
  /** Tidak ada = kemampuan browser mati di server; klik barisnya memunculkan tawaran "Nyalakan". */
  onAddBrowser?: (at?: XYPosition) => void
  /** Diff node at the click point; absent = no menu row. */
  onAddDiff?: (at?: XYPosition) => void
  /** Agent Chat node at the click point; absent = no menu row. */
  onAddAgentChat?: (at?: XYPosition) => void
  onAddAgent: (cmd: string, agentId: AgentId, cwd?: string, at?: XYPosition) => void
  /** Skill node (by reference) at the click point; absent = no "Skill…" row. */
  onAddSkill?: (skill: SkillRef, at: XYPosition) => void
  onFit: () => void
  onSelectAll: () => void
}

/**
 * Memulangkan handler untuk prop `onPaneContextMenu` React Flow, dan elemen menunya (null saat
 * tertutup). Menunya mem-portal dirinya ke `document.body`, jadi App boleh merendernya di mana pun.
 *
 * `onPaneContextMenu` React Flow hanya menyala kalau target event BENAR-BENAR elemen pane —
 * `Pane.tsx` membungkusnya dengan `wrapHandler` yang menolak event dari anak mana pun. Itulah yang
 * menjaga klik kanan di atas sebuah node tetap menjadi urusan `NodeContextMenu` saja, tanpa perlu
 * cek target di sini.
 */
export function useCanvasPaneMenu(deps: CanvasPaneMenuDeps): {
  onPaneContextMenu: (e: ReactMouseEvent | MouseEvent) => void
  menu: ReactNode
} {
  // Koordinat LAYAR untuk menaruh panelnya, koordinat FLOW (`at`) untuk melahirkan node di titik
  // klik. Dua-duanya disimpan karena konversinya butuh viewport pada saat klik.
  const [open, setOpen] = useState<{ x: number; y: number; at: XYPosition } | null>(null)
  // Tawaran menyalakan browser menggantikan isi menu (panel yang sama, titik yang sama).
  const [offering, setOffering] = useState(false)
  // "Skill…" swaps the menu for the searchable skill list at the same point (loaded only while it is open).
  const [picking, setPicking] = useState(false)
  // Titik node browser yang menunggu `onAddBrowser` terbit setelah kemampuan menyala.
  const pendingAt = useRef<{ at: XYPosition } | null>(null)
  // Dinyalakan oleh klik baris: menu menutup dirinya sesudah onSelect, tapi panelnya harus tetap hidup.
  const keepOpen = useRef(false)
  const { rf, onAddBrowser } = deps

  useEffect(() => {
    const pending = pendingAt.current
    if (!pending || !onAddBrowser) return
    pendingAt.current = null
    onAddBrowser(pending.at)
  }, [onAddBrowser])

  const onPaneContextMenu = useCallback(
    (e: ReactMouseEvent | MouseEvent) => {
      // Tanpa ini menu konteks BROWSER yang muncul — persis gejala yang dilaporkan pengguna.
      e.preventDefault()
      pendingAt.current = null
      setOffering(false)
      setPicking(false)
      const screen = { x: e.clientX, y: e.clientY }
      // Koordinat flow dihitung SEKARANG, bukan saat item dipilih: pengguna masih bisa men-pan di
      // antara keduanya, dan node harus lahir di titik yang ia klik. Tanpa instance (sebelum
      // `onInit`) dipakai apa adanya — bukan NaN.
      setOpen({ ...screen, at: rf.current?.screenToFlowPosition(screen) ?? screen })
    },
    [rf],
  )

  const close = useCallback(() => {
    if (keepOpen.current) return
    setOffering(false)
    setPicking(false)
    setOpen(null)
  }, [])

  const skillEntries = useSkillEntries(picking, deps.onAddSkill)
  const pickSkill = useCallback(() => {
    keepOpen.current = true
    queueMicrotask(() => { keepOpen.current = false }) // the menu closes itself right after onSelect
    setPicking(true)
  }, [])

  const offerBrowser = useCallback(() => {
    keepOpen.current = true
    queueMicrotask(() => { keepOpen.current = false }) // penutupan menu terjadi sinkron setelah onSelect
    setOffering(true)
  }, [])

  // Setelah menyala: cache status dibuang, hook pemilik status memuat ulang, lalu efek di atas melahirkan node.
  const offered = useCallback((at: XYPosition) => {
    pendingAt.current = { at }
    resetBrowserStatusCache()
    close()
  }, [close])

  const anchor = useMemo(() => (open ? ({ left: open.x, top: open.y, right: open.x, bottom: open.y, width: 0, height: 0 } as DOMRect) : null), [open])

  const menu = open && offering && anchor ? (
    <VscodePopover anchor={anchor} open onOpenChange={close} ariaLabel="Turn on browser">
      <div className="w-64 p-3"><CapabilityOffer id="browser" onDone={() => offered(open.at)} /></div>
    </VscodePopover>
  ) : null

  const picker = open && picking && anchor ? (
    <HandleMenuView
      point={{ x: open.x, y: open.y }} side="source" entries={skillEntries} title={SN.pickerTitle} placeholder={SN.pickerSearch} listLabel={SN.pickerGroup}
      onPick={(entry) => { entry.spawn(open.at); setPicking(false); setOpen(null) }} onClose={close}
    />
  ) : null

  const menuRows = open && !offering && !picking ? (
    <CanvasContextMenu
      x={open.x}
      y={open.y}
      onClose={close}
      // `open.at` ditutup ke dalam tiap handler DI SINI: model menu sengaja tidak tahu-menahu soal
      // koordinat, sehingga aturan isinya bisa diuji tanpa canvas.
      rows={buildCanvasMenuRows(
        {
          addTerminal: () => deps.onAddTerminal(open.at),
          addFiles: () => deps.onAddFiles(open.at),
          addBrowser: () => (onAddBrowser ? onAddBrowser(open.at) : offerBrowser()),
          addDiff: deps.onAddDiff && (() => deps.onAddDiff?.(open.at)),
          addAgentChat: deps.onAddAgentChat && (() => deps.onAddAgentChat?.(open.at)),
          addAgent: (cmd, agentId) => deps.onAddAgent(cmd, agentId, undefined, open.at),
          addSkill: deps.onAddSkill && pickSkill,
          fitView: deps.onFit,
          selectAll: deps.onSelectAll,
        },
        {
          nodeCount: deps.nodeCount,
          disabledAgents: deps.settings.disabledAgents,
          customAgents: deps.settings.customAgents,
          agentLaunchCommands: deps.settings.agentLaunchCommands,
        },
      )}
    />
  ) : null

  return { onPaneContextMenu, menu: menu ?? picker ?? menuRows }
}
