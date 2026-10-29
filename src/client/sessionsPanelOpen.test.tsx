/** @vitest-environment jsdom */
// Keadaan buka/tutup sidebar sesi, diuji di DOM. Yang diuji bukan daftarnya, melainkan SATU hal:
// saat panel tertutup, hover di atas tombol ikon TIDAK boleh membukanya — hanya klik.
//
// Sebabnya ada: panel ini dulu punya "hover-peek" (kursor lewat → panel terbuka sendiri), dan itu
// yang dilaporkan sebagai bug. Tanpa test ini, memasang kembali satu `onMouseEnter` akan
// menghidupkan ulang perilaku itu tanpa satu pun gerbang merah.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import SessionsPanel from './SessionsPanel'
import type { SessionsPanelProps } from './SessionsPanel'

const PIN_KEY = 'webterm.sessionsPinned'

const props: SessionsPanelProps = {
  workspaces: [],
  activeId: null,
  liveActiveNodes: null,
  statuses: {},
  onFocusNode: () => {},
  onCloseSession: () => {},
  onSelectWorkspace: () => {},
}

/** Panel yang dirender tertutup: `'0'` adalah nilai yang ditulis tombol Hide. */
beforeEach(() => localStorage.setItem(PIN_KEY, '0'))
afterEach(() => {
  cleanup()
  localStorage.removeItem(PIN_KEY)
})

const panel = () => screen.queryByLabelText('Sessions')
const iconButton = () => screen.getByLabelText('Show sessions')

describe('SessionsPanel buka/tutup', () => {
  it('tetap tertutup saat tombol ikon di-hover', () => {
    render(<SessionsPanel {...props} />)
    expect(panel()).toBeNull()

    // Referensi diambil SEBELUM hover: kalau hover membuka panel, tombolnya lepas dari DOM dan
    // query ulang akan gagal dengan "not found" — kegagalan yang tidak menyebut perilakunya.
    const btn = iconButton()
    fireEvent.mouseEnter(btn)
    fireEvent.mouseOver(btn)

    expect(panel()).toBeNull()
    // Tombol ikon masih di tempatnya: panel tertutup, bukan tergantikan separuh.
    expect(screen.queryByLabelText('Show sessions')).not.toBeNull()
  })

  it('terbuka saat tombol ikon diklik', () => {
    render(<SessionsPanel {...props} />)
    expect(panel()).toBeNull()

    fireEvent.click(iconButton())

    expect(panel()).not.toBeNull()
  })

  it('menutup lagi lewat tombol Hide', () => {
    render(<SessionsPanel {...props} />)
    fireEvent.click(iconButton())

    fireEvent.click(screen.getByLabelText('Hide sessions panel'))

    expect(panel()).toBeNull()
    expect(localStorage.getItem(PIN_KEY)).toBe('0')
  })
})
