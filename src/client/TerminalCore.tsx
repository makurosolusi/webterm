import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { send, subscribe } from './ws'
import { applyLiveOptions, xtermOptionsFromSettings } from './terminalConfig'
import {
  SHIFT_ENTER_SEQ,
  attachCopyOnSelect,
  guardMiddleClickPaste,
  nextTerminalFontSize,
  terminalFontZoomChord,
  terminalKeyAction,
} from './terminalKeys'
import { useLiveSettings } from './useSettings'
import type { AgentId } from '../shared/workspace'

export interface TerminalHandle {
  search(term: string, opts?: { direction?: 'next' | 'prev' }): void
  clearSearch(): void
  refit(): void
  /** Tulis data MENTAH ke PTY, seperti pengguna mengetiknya. Dipakai restart agent in-place. */
  sendKeys(data: string): void
}

export interface TerminalCoreProps {
  id: string
  cmd?: string
  cwd?: string
  agentId?: AgentId
  sessionId?: string
  resume?: boolean
  /** Judul yang dilaporkan terminal (OSC 0/2) — nama proses foreground di shell biasa. */
  onTitle?: (title: string) => void
}

/** Clipboard sistem. Jalur `writeText` bisa ditolak (permission, dokumen tak fokus, non-HTTPS);
 *  itu bukan kondisi fatal, tapi juga tidak boleh ditelan — pengguna harus bisa tahu kenapa
 *  copy-nya tidak terjadi. */
function writeClipboard(nodeId: string, text: string): void {
  navigator.clipboard?.writeText(text).catch((err: unknown) => {
    console.warn(`terminal ${nodeId}: clipboard write rejected`, err)
  })
}

/**
 * Badan xterm yang dipakai ulang: memasang terminal, berlangganan PTY-nya, dan mengirim `open`
 * awal. SENGAJA tidak mengirim `close` saat cleanup — App yang memiliki close saat node dihapus,
 * jadi berpindah workspace membiarkan PTY tetap hidup.
 *
 * Terminal dibuat SEKALI PER `id`. Dulu effect pembuatan juga mendaftarkan cmd/cwd/agentId/
 * sessionId/resume sebagai dependency — karena ia merangkap pengirim `open` yang sekali-jalan itu —
 * sehingga perubahan prop apa pun men-dispose terminal dan membuang seluruh scrollback-nya.
 * Parameter spawn sekarang dibaca dari ref saat effect jalan: nilainya sama, tanpa remount. Yang
 * membuat ini cukup: tidak ada jalur yang perlu `open` ulang dengan parameter berbeda — relaunch
 * agent memakai `sendKeys` ke PTY yang sama.
 */
const TerminalCore = forwardRef<TerminalHandle, TerminalCoreProps>(function TerminalCore(
  props,
  ref,
) {
  const { id } = props
  // Dari context, BUKAN prop: kedua call site (`TerminalNode`, `AgentNode`) tak pernah mengirim
  // prop itu, jadi ia selalu jatuh ke default dan tak satu pun setting terminal sampai ke xterm.
  const settings = useLiveSettings()
  const elRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const webglRef = useRef<WebglAddon | null>(null)

  // ponytail: zoom font per-terminal hidup di state komponen, jadi ia hilang saat node ditutup.
  // Mempersistennya butuh field di data node (milik worker lain) — angkat ke sana kalau diminta.
  const [fontZoom, setFontZoom] = useState<number | undefined>(undefined)

  // Semua yang dibaca handler yang dipasang sekali. Ditulis setiap render, jadi handler selalu
  // melihat settings mutakhir tanpa dipasang ulang.
  const live = useRef({ ...props, settings, fontZoom })
  live.current = { ...props, settings, fontZoom }

  const refit = useCallback(() => {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    fit.fit()
    term.refresh(0, term.rows - 1)
    send({ t: 'resize', id, cols: term.cols, rows: term.rows })
  }, [id])

  useImperativeHandle(
    ref,
    () => ({
      search(term, opts) {
        const s = searchRef.current
        if (!s || !term) return
        if (opts?.direction === 'prev') s.findPrevious(term)
        else s.findNext(term)
      },
      clearSearch() {
        searchRef.current?.clearDecorations?.()
        termRef.current?.clearSelection()
      },
      refit,
      sendKeys(data) {
        send({ t: 'input', id, data })
      },
    }),
    [id, refit],
  )

  useEffect(() => {
    const el = elRef.current
    if (!el) return
    const p = live.current

    const term = new Terminal(xtermOptionsFromSettings(p.settings, p.fontZoom))
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    // nodeterm sengaja TIDAK memakai addon ini (TerminalNode.tsx:3283): addon-nya tidak bisa
    // menyambung baris yang dipotong-keras tmux, jadi URL yang terlipat jadi dua link rusak.
    // webterm tidak punya tmux — output PTY tiba utuh, jadi di sini addon-nya tepat.
    term.loadAddon(new WebLinksAddon())
    try {
      term.loadAddon(new Unicode11Addon())
      // Tabel lebar default xterm adalah Unicode 6: di sana emoji selebar SATU sel. Setiap TUI
      // agent memakai emoji, jadi tanpa ini perhitungan kolomnya melayang dan rangka TUI tercabik.
      term.unicode.activeVersion = '11'
    } catch (err) {
      // Non-fatal: lebar emoji salah masih jauh lebih baik daripada terminal yang tidak muncul.
      console.warn(`terminal ${p.id}: Unicode 11 width tables unavailable`, err)
    }
    term.open(el)
    fit.fit()
    termRef.current = term
    fitRef.current = fit
    searchRef.current = search

    term.attachCustomKeyEventHandler((e) => {
      const s = live.current.settings
      if (s.terminalFontZoomKeys) {
        const zoom = terminalFontZoomChord(e)
        if (zoom) {
          e.preventDefault()
          setFontZoom((cur) => nextTerminalFontSize(zoom, cur, live.current.settings.fontSize))
          return false
        }
      }
      switch (terminalKeyAction(e, s.terminalShortcutPolicy)) {
        case 'copy':
          // Ditelan APA PUN hasilnya: melewatkan Ctrl+Shift+C saat tidak ada seleksi membuat
          // xterm memetakan ctrl+c ke \x03 dan mem-SIGINT proses foreground.
          e.preventDefault()
          if (term.hasSelection()) writeClipboard(live.current.id, term.getSelection())
          return false
        case 'shift-enter':
          e.preventDefault()
          send({ t: 'input', id: live.current.id, data: SHIFT_ENTER_SEQ })
          return false
        case 'bubble':
        case 'native':
          // TANPA preventDefault — event yang ditandai `defaultPrevented` membuat dispatcher
          // app/browser mundur, jadi justru membunuh dispatch yang mau dicapai.
          return false
        default:
          return true
      }
    })

    const detachCopy = attachCopyOnSelect(term, {
      enabled: () => live.current.settings.copyOnSelect,
      write: (text) => writeClipboard(live.current.id, text),
    })
    const detachMiddle = guardMiddleClickPaste(
      el,
      () => live.current.settings.terminalMiddleClickPaste,
    )
    const titleSub = term.onTitleChange((t) => live.current.onTitle?.(t))

    const unsub = subscribe(
      id,
      (d) => term.write(d),
      () => term.write('\r\n[process exited]'),
    )
    term.onData((d) => send({ t: 'input', id, data: d }))
    // `open` menyusul fit supaya server men-spawn PTY pada ukuran yang benar.
    send({
      t: 'open',
      id,
      cols: term.cols,
      rows: term.rows,
      ...(p.cwd ? { cwd: p.cwd } : {}),
      ...(p.cmd ? { cmd: p.cmd } : {}),
      ...(p.agentId ? { agentId: p.agentId } : {}),
      ...(p.sessionId ? { sessionId: p.sessionId } : {}),
      ...(p.resume ? { resume: true } : {}),
    })

    const ro = new ResizeObserver(() => {
      fit.fit()
      send({ t: 'resize', id, cols: term.cols, rows: term.rows })
    })
    ro.observe(el)

    return () => {
      ro.disconnect()
      titleSub.dispose()
      detachMiddle()
      detachCopy()
      unsub()
      term.dispose() // ikut men-dispose addon yang dimuatnya, WebGL termasuk
      termRef.current = null
      fitRef.current = null
      searchRef.current = null
      webglRef.current = null
    }
  }, [id])

  // Terapkan settings ke terminal yang hidup. Jalan juga tepat setelah pembuatan: semua opsi sudah
  // cocok di sana, jadi `applyLiveOptions` tidak menulis apa pun dan ini praktis cuma attach WebGL.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const { metricsChanged, themeChanged } = applyLiveOptions(term, settings, fontZoom)
    // Geometri sel berubah ⇒ grid-nya beda ⇒ PTY harus diberi tahu, lewat jalur resize yang sama.
    if (metricsChanged) refit()
    else if (themeChanged) term.refresh(0, term.rows - 1)

    const wantGpu = settings.terminalGpuRendering === 'auto'
    if (wantGpu && !webglRef.current) {
      try {
        const addon = new WebglAddon()
        // Konteks WebGL bisa hilang (GPU reset, driver, tab lama di background). Dispose membuat
        // xterm jatuh ke renderer DOM secara sinkron; tanpa ini terminal berhenti mengecat.
        addon.onContextLoss(() => {
          addon.dispose()
          webglRef.current = null
        })
        term.loadAddon(addon)
        webglRef.current = addon
      } catch (err) {
        // Konteks bisa ditolak (WebGL dimatikan, kehabisan konteks). Renderer DOM tetap benar.
        console.warn(`terminal ${id}: WebGL renderer unavailable, using DOM renderer`, err)
      }
    } else if (!wantGpu && webglRef.current) {
      webglRef.current.dispose()
      webglRef.current = null
    }
  }, [id, settings, fontZoom, refit])

  return <div ref={elRef} className="nodrag" style={{ height: '100%', width: '100%' }} />
})

export default TerminalCore
