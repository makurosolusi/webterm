/** @vitest-environment jsdom */
// Kontrak terkontrol side bar kiri. Yang diuji di sini HANYA dua hal milik shell-nya sendiri:
//
//   1. `open={false}` berarti side bar tidak merender apa pun — TIDAK ada tombol pelontar sendiri di
//      tepi kiri. Pelontar kedua di tepi itulah yang dulu bertumpuk dengan kolom dock.
//   2. Tombol Hide tidak menutup dirinya sendiri, ia melapor ke `onClose`. Keadaannya dimiliki App
//      (lihat `useSessionsOpen`), karena ikon pembukanya hidup di Dock.
//
// Invarian "hover TIDAK membuka" menggantung di ikon dock, jadi ia diuji di canvas sungguhan:
// lihat `./dockSessions.test.tsx`.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import SessionsPanel from './SessionsPanel'
import SideBar, { type SideBarProps } from './sideBar/SideBar'

/** Visible tooltip of `el` (focus opens it); the label is the tooltip, not a native `title`. */
const tipOf = (el: Element): string | null => {
  fireEvent.keyDown(document, { key: 'Tab' }) // keyboard navigation: focus alone does not open a tooltip
  fireEvent.focus(el)
  const text = document.querySelector('[role="tooltip"]')?.textContent ?? null
  fireEvent.blur(el)
  return text
}

const sessions = (
  <SessionsPanel active workspaces={[]} activeId={null} liveActiveNodes={null} statuses={{}}
    onFocusNode={() => {}} onCloseSession={() => {}} onSelectWorkspace={() => {}} />
)
const props: SideBarProps = { open: true, view: 'sessions', onClose: () => {}, layers: null, sessions, history: null, skills: null }

afterEach(cleanup)

const panel = () => screen.queryByLabelText('Side Bar')

describe('side bar terkontrol', () => {
  it('tertutup berarti tidak merender apa pun, pelontar sendiri sekalipun', () => {
    const { container } = render(<SideBar {...props} open={false} />)

    expect(panel()).toBeNull()
    expect(container.innerHTML).toBe('')
  })

  it('terbuka merender side bar-nya', () => {
    render(<SideBar {...props} />)

    expect(panel()).not.toBeNull()
  })

  it('tombol Hide melapor ke onClose, bukan menutup diri sendiri', () => {
    let closed = 0
    render(<SideBar {...props} onClose={() => (closed += 1)} />)

    expect(tipOf(screen.getByLabelText('Hide Side Bar'))).toBe('Hide Side Bar')
    expect(tipOf(screen.getByLabelText('Collapse all'))).toBe('Collapse all groups')
    fireEvent.change(screen.getByLabelText('Filter sessions'), { target: { value: 'x' } })
    expect(tipOf(screen.getByLabelText('Clear filter'))).toBe('Clear filter Esc')
    fireEvent.click(screen.getByLabelText('Hide Side Bar'))

    expect(closed).toBe(1)
    // Masih terbuka: propsnya belum berubah. Side bar yang menutup dirinya sendiri di sini akan
    // menyimpang dari keadaan yang dipegang App — dan ikon dock ikut salah menunjuk.
    expect(panel()).not.toBeNull()
  })
})
