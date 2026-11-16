import type { Terminal } from '@xterm/xterm'
import { isMacPlatform } from './terminalKeys.platform'

/* --- Mouse ---------------------------------------------------------------------------------- */

/** Tombol mouse TENGAH, sebagaimana `MouseEvent.button` menomorinya (0 kiri, 1 tengah, 2 kanan). */
const MIDDLE_BUTTON = 1

/**
 * Haruskah event mouse ini ditelan sebelum xterm melihatnya? Murni, jadi aturannya bisa dipaku
 * tanpa DOM. Satu baris dan tetap layak dinamai, karena dua paruhnya mudah tertukar: `allow`
 * adalah setting pengguna "klik tengah boleh paste", jadi MENEKAN adalah yang terjadi saat OFF.
 */
export function suppressMiddleClickPaste(button: number, allow: boolean): boolean {
  return button === MIDDLE_BUTTON && !allow
}

/**
 * Hentikan klik tengah di dalam terminal mem-paste teks ke PTY.
 *
 * `preventDefault` SAJA tidak bisa bekerja: tidak ada aksi default browser di jalur ini — xterm
 * meneruskan LAPORAN MOUSE untuk tombol tengah ke PTY, dan yang mem-paste adalah sesuatu di
 * HILIRNYA (TUI yang membaca seleksi PRIMARY X). Jadi tuas yang bekerja adalah PROPAGASI: hentikan
 * event di fase CAPTURE pada host, sebelum listener xterm (terpasang di descendant) sempat jalan,
 * dan tak ada laporan yang diteruskan. Tidak ada hook yang lebih sempit — xterm tidak mengekspos
 * handler publik untuk tombol mouse (hanya `attachCustomKeyEventHandler` /
 * `attachCustomWheelEventHandler`).
 *
 * KONSEKUENSI YANG HARUS DIMILIKI SETTING INI: dengan setting OFF, tombol tengah sepenuhnya INERT
 * di dalam terminal — bukan "browser tidak mem-paste", tapi "klik tengah tidak melakukan apa pun
 * di sini". Itu perilaku yang diminta; salinan teks Settings harus mengatakan hal yang sama.
 *
 * `allow` dibaca pada WAKTU EVENT, bukan waktu attach, jadi membalik setting berlaku pada klik
 * berikutnya alih-alih pada terminal berikutnya.
 */
export function guardMiddleClickPaste(host: HTMLElement, allow: () => boolean): () => void {
  const onEvent = (e: MouseEvent): void => {
    if (!suppressMiddleClickPaste(e.button, allow())) return
    e.preventDefault()
    e.stopPropagation()
    // Membungkam juga listener lain di host itu sendiri, bukan hanya descendant.
    e.stopImmediatePropagation()
  }
  host.addEventListener('mousedown', onEvent, true)
  host.addEventListener('mouseup', onEvent, true)
  host.addEventListener('auxclick', onEvent, true)
  return () => {
    host.removeEventListener('mousedown', onEvent, true)
    host.removeEventListener('mouseup', onEvent, true)
    host.removeEventListener('auxclick', onEvent, true)
  }
}

/** Potongan `Terminal` xterm yang dibaca copy-on-select — sempit, supaya test tak butuh xterm. */
export interface CopyOnSelectTerminal {
  readonly element: HTMLElement | undefined
  readonly modes: { readonly mouseTrackingMode: Terminal['modes']['mouseTrackingMode'] }
  readonly options: { readonly macOptionClickForcesSelection?: boolean }
  hasSelection(): boolean
  getSelection(): string
}


/**
 * Whether xterm's own selection handling takes this mousedown: primary button only; always when
 * no program inside the terminal is tracking the mouse; otherwise only when selection is forced
 * (Option with `macOptionClickForcesSelection` on macOS, Shift elsewhere).
 */
export function xtermOwnsMouseDown(
  e: Pick<MouseEvent, 'button' | 'altKey' | 'shiftKey'>,
  mouseTrackingMode: CopyOnSelectTerminal['modes']['mouseTrackingMode'],
  platform: { isMac: boolean; optionForces: boolean },
): boolean {
  if (e.button !== 0) return false
  if (mouseTrackingMode === 'none') return true
  const forceKey = platform.isMac ? e.altKey && platform.optionForces : e.shiftKey
  return forceKey
}

export interface CopyOnSelectDeps {
  /** Live setting, read at event time rather than captured. */
  enabled: () => boolean
  /** Writes to the system clipboard. */
  write: (text: string) => void
  isMac?: boolean
}

/**
 * Copy the terminal selection to the clipboard when a mouse selection gesture ends. Returns a
 * disposer. A no-op for a terminal that is not opened yet.
 *
 * Why a gesture instead of `onSelectionChange`: that event also fires for programmatic selections
 * (the search addon selects every hit) and when a selection is cleared. So a gesture starts with a
 * primary press inside the terminal element that xterm handles itself, and ends with a primary
 * release anywhere in the window (drags often leave the node). Double/triple-click word and line
 * selections are the same gesture.
 *
 * Timing: xterm finalizes the selection from a bubble-phase `mouseup` listener on the document,
 * whereas ours runs in the window capture phase, i.e. earlier. The read is therefore deferred with
 * a macrotask (`setTimeout 0`); a microtask would still run before xterm's listener.
 *
 * An empty selection is never written, because a plain click clears the selection and writing ''
 * would wipe the clipboard.
 */
export function attachCopyOnSelect(term: CopyOnSelectTerminal, deps: CopyOnSelectDeps): () => void {
  const element = term.element
  if (!element) return () => {}
  const win = element.ownerDocument.defaultView ?? window
  const isMac = deps.isMac ?? isMacPlatform()

  // Everything belonging to one in-flight gesture hangs off this controller; aborting it removes
  // the window listeners. A gesture that loses its release (window blur, another press, dispose)
  // is dropped without writing, otherwise a stale selection would be copied on the next release.
  let gesture: AbortController | null = null
  let pendingRead: ReturnType<typeof setTimeout> | undefined

  const dropGesture = (): void => {
    gesture?.abort()
    gesture = null
  }
  const reset = (): void => {
    dropGesture()
    clearTimeout(pendingRead)
    pendingRead = undefined
  }

  const copySelection = (): void => {
    pendingRead = undefined
    if (!deps.enabled() || !term.hasSelection()) return
    const text = term.getSelection()
    if (text) deps.write(text)
  }

  const onPress = (press: MouseEvent): void => {
    if (!deps.enabled()) return
    const handledByXterm = xtermOwnsMouseDown(press, term.modes.mouseTrackingMode, {
      isMac,
      optionForces: term.options.macOptionClickForcesSelection === true,
    })
    if (!handledByXterm) return
    reset()
    const ctl = new AbortController()
    gesture = ctl
    const opts = { capture: true, signal: ctl.signal }
    win.addEventListener(
      'mouseup',
      (release) => {
        // Only the primary release completes it; a right/middle release mid-drag must not copy
        // a half-made selection.
        if (release.button !== 0) return
        dropGesture()
        pendingRead = setTimeout(copySelection, 0)
      },
      opts,
    )
    win.addEventListener('blur', dropGesture, { signal: ctl.signal })
    // Registered during this press's element-capture phase, so it cannot fire for this press
    // (the window capture phase has already passed) - only for the next one.
    win.addEventListener('mousedown', dropGesture, opts)
  }

  // Capture phase: xterm stops propagation of a forced-selection mousedown from its own bubble
  // listener on this same element.
  element.addEventListener('mousedown', onPress, true)
  return () => {
    element.removeEventListener('mousedown', onPress, true)
    reset()
  }
}
