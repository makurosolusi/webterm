import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { send, subscribe } from './ws'
import { writeClipboard } from './clipboard'
import { TerminalOffline } from './TerminalCore.offline'
import { lineEditSeq } from './terminalLineEdit'
import { OPEN_SIZE_FALLBACK_MS, canOpenSession, coalesceFrames, sizeChanged, watchVisible } from './terminalSizing'
import type { TermSize } from './terminalSizing'
import { canClaimFocus, exitMessage, openLinkOnModifiedClick } from './terminalSession'
import { applyLiveOptions, xtermOptionsFromSettings } from './terminalConfig'
import {
  SHIFT_ENTER_SEQ,
  attachCopyOnSelect,
  guardMiddleClickPaste,
  isLinuxPlatform,
  nextTerminalFontSize,
  optionArrowSeq,
  terminalKeyAction,
  terminalZoomAction,
} from './terminalKeys'
import { installPointerScaleFix } from './terminalScale'
import { useLiveSettings } from './useSettings'
import type { AgentId } from '../shared/workspace'

export interface TerminalHandle {
  search(term: string, opts?: { direction?: 'next' | 'prev' }): void
  clearSearch(): void
  refit(): void
  /** Tulis data MENTAH ke PTY, seperti pengguna mengetiknya. Dipakai restart agent in-place. */
  sendKeys(data: string): void
  /** Buang scrollback, sisakan baris yang sedang tampil. Murni sisi klien: PTY tidak diberi tahu,
   *  jadi prompt dan proses foreground tidak tersentuh. */
  clear(): void
  /** Paste ala terminal asli: `term.paste` membungkus bracketed-paste bila aplikasi memintanya. */
  paste(text: string): void
  hasSelection(): boolean
  getSelection(): string
  /** Fokus ke terminal, kecuali input lain (rename, dialog) sedang memegangnya. */
  focus(): void
  /** Link di bawah kursor (null bila tidak ada); menu klik-kanan menangkapnya saat dibuka. */
  hoveredLink(): string | null
}

export interface TerminalCoreProps {
  id: string
  cmd?: string
  cwd?: string
  agentId?: AgentId
  sessionId?: string
  resume?: boolean
  /** Launch profile of a builtin claude node; the server resolves it to the launch command. */
  claudeProfileId?: string
  /** Judul yang dilaporkan terminal (OSC 0/2) — nama proses foreground di shell biasa. */
  onTitle?: (title: string) => void
}

/** Copy gagal bukan fatal, tapi tidak boleh ditelan: tanpa jejak, copy yang tak terjadi tak
 *  bisa dibedakan dari seleksi kosong. */
function copyText(nodeId: string, text: string): void {
  void writeClipboard(text).then((ok) => {
    if (!ok) console.warn(`terminal ${nodeId}: clipboard write failed`)
  })
}

/** Node yang di-collapse hanya DISEMBUNYIKAN (`.term-node--collapsed .node-body { display: none }`
 *  di node-chrome.css), bukan di-unmount — itulah sebabnya ia mempertahankan PTY-nya. Konsekuensinya
 *  elemen host xterm jadi 0×0, dan FitAddon tetap menghitung cols/rows dari dimensi nol itu.
 *  `term.resize()` ke ukuran mikro hasilnya ME-REFLOW buffer, dan reflow tidak punya operasi
 *  balikan: scrollback-nya rusak PERMANEN, bukan cuma tak tergambar — karena itu menggambar ulang
 *  (tombol refresh) tak bisa memulihkannya. Jadi 0×0 dibaca sebagai "sedang tersembunyi": tidak ada
 *  ukuran bermakna untuk dipasang, dan saat node di-expand elemen kembali punya ukuran sehingga
 *  ResizeObserver menyala sendiri. */
function hasSize(el: HTMLElement): boolean {
  return el.clientWidth > 0 && el.clientHeight > 0
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
  const linkRef = useRef<string | null>(null)
  const shownRef = useRef<{ readonly visible: boolean } | null>(null)
  // `last` = ukuran terakhir yang dikirim (via `open` atau `resize`); dedupe SIGWINCH bertumpu padanya.
  const session = useRef<{ opened: boolean; last: TermSize | null; open: () => void }>({
    opened: false,
    last: null,
    open: () => {},
  })

  // ponytail: zoom font per-terminal hidup di state komponen, jadi ia hilang saat node ditutup.
  // Mempersistennya butuh field di data node (milik worker lain) — angkat ke sana kalau diminta.
  const [fontZoom, setFontZoom] = useState<number | undefined>(undefined)

  // Semua yang dibaca handler yang dipasang sekali. Ditulis setiap render, jadi handler selalu
  // melihat settings mutakhir tanpa dipasang ulang.
  const live = useRef({ ...props, settings, fontZoom })
  live.current = { ...props, settings, fontZoom }

  // SATU-SATUNYA jalur fit+resize: `ResizeObserver` memakai ini juga, supaya gerbang `hasSize`
  // cukup ditegakkan di satu tempat. Sebelum `open` terkirim, ukuran pertama ikut di `open`.
  const refit = useCallback(() => {
    const term = termRef.current
    const fit = fitRef.current
    const el = elRef.current
    // Un-hiding (tab switch, canvas<->tabs) fires the ResizeObserver BEFORE xterm's renderer resumes;
    // resizing then scrolls the buffer to the top (see `watchVisible`). The visibility watcher refits
    // once xterm is live again, so skipping here loses nothing. A not-yet-opened session still goes on:
    // its `open` must not wait for visibility. (Kept above the size gate so `hasSize` stays adjacent
    // to the fit call, which terminalFit.test.ts enforces.)
    if (session.current.opened && shownRef.current?.visible === false) return
    if (!term || !fit || !el || !hasSize(el)) return
    fit.fit()
    term.refresh(0, term.rows - 1)
    const s = session.current
    if (!s.opened) {
      s.open()
      return
    }
    const next = { cols: term.cols, rows: term.rows }
    if (!sizeChanged(s.last, next)) return
    s.last = next
    send({ t: 'resize', id, ...next })
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
      clear() {
        termRef.current?.clear()
      },
      paste(text) {
        termRef.current?.paste(text)
      },
      hoveredLink: () => linkRef.current,
      hasSelection: () => termRef.current?.hasSelection() ?? false,
      getSelection: () => termRef.current?.getSelection() ?? '',
      focus() {
        if (canClaimFocus(document.activeElement as HTMLElement | null, true)) termRef.current?.focus()
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
    term.loadAddon(new WebLinksAddon((e, uri) => openLinkOnModifiedClick(e, uri), {
      hover: (_e, text) => { linkRef.current = text },
      leave: () => { linkRef.current = null },
    }))
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
    // SESUDAH `open`: service pointer yang dibungkusnya baru lahir di dalam `open()`. Tanpa ini
    // seleksi mendarat di baris yang salah begitu canvas di-zoom; lihat `terminalScale.ts`.
    installPointerScaleFix(term)
    // Node bisa LAHIR sudah ter-collapse (collapse ikut tersimpan di layout workspace), jadi jalur
    // ini pun bergerbang — kalau tidak, `open` di bawah men-spawn PTY selebar ~1 kolom.
    if (hasSize(el)) fit.fit()
    termRef.current = term
    fitRef.current = fit
    searchRef.current = search
    if (canClaimFocus(document.activeElement as HTMLElement | null, false)) term.focus()

    term.attachCustomKeyEventHandler((e) => {
      const s = live.current.settings
      if (s.terminalFontZoomKeys) {
        const zoom = terminalZoomAction(e)
        if (zoom) {
          e.preventDefault()
          setFontZoom((cur) => nextTerminalFontSize(zoom, cur, live.current.settings.fontSize))
          return false
        }
      }
      const lineSeq = optionArrowSeq(e) ?? lineEditSeq(e)
      if (lineSeq) {
        e.preventDefault()
        send({ t: 'input', id: live.current.id, data: lineSeq })
        return false
      }
      switch (terminalKeyAction(e, s.terminalShortcutPolicy)) {
        case 'copy':
          // Ditelan APA PUN hasilnya: melewatkan Ctrl+Shift+C saat tidak ada seleksi membuat
          // xterm memetakan ctrl+c ke \x03 dan mem-SIGINT proses foreground.
          e.preventDefault()
          if (term.hasSelection()) copyText(live.current.id, term.getSelection())
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
      write: (text) => copyText(live.current.id, text),
    })
    const detachMiddle = guardMiddleClickPaste(
      el,
      // Automatic per OS: middle-click paste is a Linux convention; elsewhere the button stays inert.
      () => isLinuxPlatform(),
    )
    const titleSub = term.onTitleChange((t) => live.current.onTitle?.(t))

    const unsub = subscribe(
      id,
      (d) => term.write(d),
      (code, reason) => term.write(exitMessage(code, reason)),
      () => term.reset(),
    )
    term.onData((d) => send({ t: 'input', id, data: d }))
    // `open` menyusul fit supaya server men-spawn PTY pada ukuran yang benar. Elemen yang belum
    // berukuran menunda `open` ke `refit` pertama yang berukuran, dengan batas waktu supaya node
    // yang tetap collapsed tidak menggantung tanpa sesi.
    const s = session.current
    s.opened = false
    s.last = null
    let fallback: ReturnType<typeof setTimeout> | undefined
    s.open = () => {
      if (s.opened) return
      s.opened = true
      clearTimeout(fallback)
      s.last = { cols: term.cols, rows: term.rows }
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
        ...(p.claudeProfileId ? { claudeProfileId: p.claudeProfileId } : {}),
      })
    }
    if (canOpenSession(hasSize(el), false)) s.open()
    else fallback = setTimeout(() => { if (canOpenSession(false, true)) s.open() }, OPEN_SIZE_FALLBACK_MS)

    const frames = coalesceFrames(refit)
    const ro = new ResizeObserver(frames.schedule)
    ro.observe(el)
    // After `term.open` on purpose: must be notified after xterm's own IntersectionObserver.
    const shown = watchVisible(el, frames.schedule)
    shownRef.current = shown

    return () => {
      clearTimeout(fallback)
      frames.cancel()
      s.opened = false
      ro.disconnect()
      shown.stop()
      shownRef.current = null
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
    // `refit` dipakai di dalam tapi SENGAJA tidak didaftarkan: ia di-memo pada `[id]` juga, jadi
    // `[id]` sudah menutupinya — dan deps effect ini wajib tetap `[id]` saja (terminalConfig.test.ts),
    // karena dependency tambahan apa pun men-dispose terminal dan membuang scrollback-nya.
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

    // WebGL per terminal, falling back to the DOM renderer on its own when a context fails or is lost.
    if (!webglRef.current) {
      try {
        // `true` = preserveDrawingBuffer: without it the WebGL canvas reads back blank, and the
        // central agent's screenshot (`./canvasShot`) shows empty terminals.
        const addon = new WebglAddon(true)
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
    }
  }, [id, settings, fontZoom, refit])

  return (
    <div className="relative size-full">
      <div ref={elRef} className="nodrag nowheel size-full" />
      <TerminalOffline />
    </div>
  )
})

export default TerminalCore
