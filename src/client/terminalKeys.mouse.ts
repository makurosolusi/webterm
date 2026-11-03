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
 * Apakah SelectionService xterm mengambil mousedown ini? Mencerminkan `handleMouseDown` +
 * `shouldForceSelection` xterm: tombol primer saja; selalu saat tidak ada app yang melacak mouse
 * (service-nya aktif); selain itu hanya saat dipaksa — Option (dengan
 * `macOptionClickForcesSelection`) di macOS, Shift di tempat lain.
 */
export function xtermOwnsMouseDown(
  e: Pick<MouseEvent, 'button' | 'altKey' | 'shiftKey'>,
  mouseTrackingMode: CopyOnSelectTerminal['modes']['mouseTrackingMode'],
  platform: { isMac: boolean; optionForces: boolean },
): boolean {
  if (e.button !== 0) return false
  if (mouseTrackingMode === 'none') return true
  return platform.isMac ? e.altKey && platform.optionForces : e.shiftKey
}

export interface CopyOnSelectDeps {
  /** Setting live. Dibaca pada waktu event, tidak pernah ditangkap closure. */
  enabled: () => boolean
  /** Menulis clipboard sistem. */
  write: (text: string) => void
  isMac?: boolean
}

/**
 * Pasang copy-on-select ke terminal yang sudah DIBUKA. Mengembalikan disposer.
 *
 * SELEKSI MANA YANG DIHITUNG — dan kenapa ini BUKAN subscription `onSelectionChange`. Event itu
 * juga menyala untuk seleksi PROGRAMATIK (addon search memanggil `Terminal.select()` untuk setiap
 * hit yang dilangkahi pengguna) dan saat seleksi dihapus. Jadi pemicunya adalah GESTUR-nya: tekan
 * tombol primer di dalam `term.element` yang diambil SelectionService xterm (`xtermOwnsMouseDown`),
 * diikuti rilis DI MANA PUN di window — drag sangat sering melewati batas node, dan xterm sendiri
 * mendengarkan rilis itu di document. Seleksi kata/baris dari double/triple-click adalah gestur
 * yang sama dengan `detail` 2/3 dan ikut tercakup gratis.
 *
 * URUTAN: pada mousedown, xterm menambahkan listener `mouseup` fase-bubble di DOCUMENT dan
 * memfinalkan seleksi di sana. Listener rilis kita ada di WINDOW fase CAPTURE (supaya tak ada yang
 * di bawahnya bisa menghentikannya), jadi ia jalan SEBELUM milik xterm. Pembacaan karenanya
 * ditunda dengan macrotask (`setTimeout 0`) — BUKAN `queueMicrotask`: untuk event pengguna nyata,
 * checkpoint microtask jalan di antara callback listener, yang masih sebelum listener document
 * xterm.
 *
 * TIDAK PERNAH MENULIS KOSONG: klik biasa menghapus seleksi; menulis `''` akan mengosongkan
 * clipboard.
 */
export function attachCopyOnSelect(term: CopyOnSelectTerminal, deps: CopyOnSelectDeps): () => void {
  const element = term.element
  if (!element) return () => {}
  const win = element.ownerDocument.defaultView ?? window
  const isMac = deps.isMac ?? isMacPlatform()
  let pendingUp: ((e: MouseEvent) => void) | null = null
  let readTimer: ReturnType<typeof setTimeout> | null = null

  // Mengakhiri gestur yang ter-arm TANPA menulis. Gestur yang kehilangan rilisnya dan listener-nya
  // tetap hidup akan menyalin apa pun yang terseleksi saat rilis BERIKUTNYA datang — highlight
  // basi atau hit pencarian. Tiga cara rilis bisa hilang: blur (tombol ditahan, dilepas di app
  // lain), mousedown lain di window, dan dispose.
  const disarm = (): void => {
    if (pendingUp) win.removeEventListener('mouseup', pendingUp, true)
    pendingUp = null
    win.removeEventListener('blur', disarm)
    win.removeEventListener('mousedown', disarm, true)
  }

  const clearPending = (): void => {
    disarm()
    if (readTimer !== null) clearTimeout(readTimer)
    readTimer = null
  }

  const onDown = (e: MouseEvent): void => {
    if (!deps.enabled()) return
    const owned = xtermOwnsMouseDown(e, term.modes.mouseTrackingMode, {
      isMac,
      optionForces: term.options.macOptionClickForcesSelection === true,
    })
    if (!owned) return
    clearPending()
    const onUp = (up: MouseEvent): void => {
      // Hanya rilis PRIMER yang menyelesaikan gestur: rilis kanan/tengah di tengah drag akan
      // menyalin seleksi separuh jalan dan menjatuhkan yang sebenarnya.
      if (up.button !== 0) return
      disarm()
      readTimer = setTimeout(() => {
        readTimer = null
        if (!deps.enabled() || !term.hasSelection()) return
        const text = term.getSelection()
        if (text) deps.write(text)
      }, 0)
    }
    pendingUp = onUp
    win.addEventListener('mouseup', onUp, true)
    win.addEventListener('blur', disarm)
    // Ditambahkan selagi fase capture ELEMENT dari tekanan INI, jadi ia tidak bisa menyala untuk
    // tekanan ini: fase capture window sudah terlewat.
    win.addEventListener('mousedown', disarm, true)
  }

  // Fase capture karena xterm memanggil `stopPropagation` pada mousedown yang dipaksa, dari
  // listener bubble-nya di elemen yang sama.
  element.addEventListener('mousedown', onDown, true)
  return () => {
    element.removeEventListener('mousedown', onDown, true)
    clearPending()
  }
}
