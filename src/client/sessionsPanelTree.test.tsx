/** @vitest-environment jsdom */
// Kontrak pohon sesi: sidebar kini `vscode-tree`, jadi yang diuji di sini adalah jembatan antara
// shadow tree dan callback React — bukan tampilan barisnya (itu urusan CSS).
//
//   1. Grup jadi branch, sesi jadi leaf yang bisa dipilih → `onFocusNode`.
//   2. Header grup workspace hanya melipat; pindah board lewat inline action (lihat sessionsGroupSwitch.policy).
//   3. Tombol akhiri sesi berjalan lewat listener natif (klik di dalam tree dihentikan library).
//   4. Tab pengelompokan dan filter tetap memilih himpunan baris yang sama seperti sebelumnya.
//
// Event tree dikirim sebagai `vsc-tree-select` natif: itu persis event yang dipancarkan library
// saat baris diklik/di-Enter, dan listener panel memang dipasang natif di elemen `vscode-tree`.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SessionsPanel, { type SessionsPanelProps } from './SessionsPanel'
import { DEFAULT_VIEWPORT } from '../shared/workspace'
import type { AgentStatus, Workspace, WsNode } from '../shared/workspace'

const node = (id: string, title: string, extra: Partial<WsNode> = {}): WsNode => ({
  id,
  kind: 'terminal',
  title,
  x: 0,
  y: 0,
  ...extra,
})

const ws = (id: string, name: string, nodes: WsNode[]): Workspace => ({
  id,
  name,
  viewport: DEFAULT_VIEWPORT,
  nodes,
  bridges: [],
  updatedAt: 0,
})

const ALPHA = ws('p1', 'Alpha', [node('t1', 'Build'), node('t2', 'Test')])
const BETA = ws('p2', 'Beta', [node('t3', 'Deploy')])
/** The open board, listed first in the Project tab (marked Current) with no sessions. */
const CURRENT = ws('p0', 'Current', [])
const STATUSES: Record<string, AgentStatus> = { t1: 'working', t2: 'done', t3: 'done' }

const baseProps = (): SessionsPanelProps => ({
  active: true,
  workspaces: [CURRENT, ALPHA, BETA],
  activeId: 'p0',
  liveActiveNodes: null,
  statuses: STATUSES,
  onFocusNode: () => {},
  onCloseSession: () => {},
  onSelectWorkspace: () => {},
})

/** Simpul pohon milik sebuah nama aksesibel. Aria-label dipasang React sebagai atribut, jadi ia
 *  tetap terbaca di jsdom walau properti custom element lain tidak diteruskan build SSR. */
const item = (label: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`vscode-tree-item[aria-label="${label}"]`)
  if (!el) throw new Error(`tree item "${label}" tidak ada`)
  return el
}

const tree = (): HTMLElement => {
  const el = document.querySelector<HTMLElement>('vscode-tree')
  if (!el) throw new Error('vscode-tree tidak dirender')
  return el
}

function select(el: Element): void {
  // Bentuk RUNTIME library: `detail` adalah array item. `.d.ts`-nya menulis `{ selectedItems }`,
  // dan panel menerima keduanya — tapi yang diuji sebagai jalur utama adalah yang benar-benar
  // dipancarkan saat baris diklik.
  tree().dispatchEvent(new CustomEvent('vsc-tree-select', { detail: [el] }))
}

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe('SessionsPanel sebagai VS Code tree', () => {
  it('merender grup sebagai branch dan sesi sebagai leaf', () => {
    render(<SessionsPanel {...baseProps()} />)

    expect(tree()).not.toBeNull()
    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.getByText('Beta')).toBeTruthy()
    expect(screen.getByText('Build')).toBeTruthy()
    expect(item('Build — Running')).toBeTruthy()
  })

  it('memilih sesi memfokuskan node-nya', () => {
    const onFocusNode = vi.fn()
    render(<SessionsPanel {...baseProps()} onFocusNode={onFocusNode} />)

    select(item('Build — Running'))

    expect(onFocusNode).toHaveBeenCalledWith('t1')
  })

  it('menerima bentuk detail bertipe `{ selectedItems }` juga', () => {
    const onFocusNode = vi.fn()
    render(<SessionsPanel {...baseProps()} onFocusNode={onFocusNode} />)

    tree().dispatchEvent(
      new CustomEvent('vsc-tree-select', { detail: { selectedItems: [item('Build — Running')] } }),
    )

    expect(onFocusNode).toHaveBeenCalledWith('t1')
  })

  it('memilih grup workspace hanya melipat/membuka (tidak berpindah board), lipatannya tersinkron', async () => {
    const onSelectWorkspace = vi.fn()
    render(<SessionsPanel {...baseProps()} onSelectWorkspace={onSelectWorkspace} />)

    const beta = document.querySelector<HTMLElement>('vscode-tree-item[data-group="project:p2"]')
    expect(beta).not.toBeNull()
    // Library membalik `open` setelah event; beri nilai "terbuka" supaya sinkronisasi lipatan
    // punya sesuatu untuk dibalik.
    ;(beta as HTMLElement & { open: boolean }).open = true
    select(beta as Element)

    expect(onSelectWorkspace).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem('webterm.sessionsCollapsed') ?? '{}')).toMatchObject({
        'project:p2': true,
      }),
    )
  })

  it('tombol akhiri sesi menutup sesi tanpa memfokuskan node', () => {
    const onCloseSession = vi.fn()
    const onFocusNode = vi.fn()
    render(
      <SessionsPanel {...baseProps()} onCloseSession={onCloseSession} onFocusNode={onFocusNode} />,
    )

    const end = screen.getByLabelText('End session Build')
    expect(end.hasAttribute('title')).toBe(false)
    fireEvent.keyDown(document, { key: 'Tab' }) // keyboard navigation: focus alone does not open a tooltip
    fireEvent.focus(end)
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('End session')
    fireEvent.blur(end)
    fireEvent.click(end)

    expect(onCloseSession).toHaveBeenCalledWith('t1')
    expect(onFocusNode).not.toHaveBeenCalled()
  })

  it('klik tengah pada baris tetap menutup sesi', () => {
    const onCloseSession = vi.fn()
    render(<SessionsPanel {...baseProps()} onCloseSession={onCloseSession} />)

    fireEvent(
      screen.getByText('Build'),
      new MouseEvent('auxclick', { bubbles: true, button: 1 }),
    )

    expect(onCloseSession).toHaveBeenCalledWith('t1')
  })

  it('tab Status mengelompokkan per status dan tetap menyembunyikan seksi kosong', () => {
    render(<SessionsPanel {...baseProps()} />)

    fireEvent.click(screen.getByRole('tab', { name: 'Status' }))

    const groups = [...document.querySelectorAll('vscode-tree-item[data-group]')].map((el) =>
      el.getAttribute('data-group'),
    )
    expect(groups).toContain('status:working')
    expect(groups).toContain('status:idle')
    // attention nol, bukan "belum dihitung" — headernya tetap tampil.
    expect(groups).toContain('status:attention')
    expect(groups).not.toContain('status:unknown')
  })

  it('filter memangkas baris tanpa kehilangan pohonnya', () => {
    render(<SessionsPanel {...baseProps()} />)

    fireEvent.change(screen.getByLabelText('Filter sessions'), { target: { value: 'deploy' } })

    expect(screen.queryByText('Build')).toBeNull()
    expect(screen.getByText('Deploy')).toBeTruthy()
    expect(screen.getByText('Beta')).toBeTruthy()
    expect(screen.queryByText('Alpha')).toBeNull()
  })

  it('hanya Project dan Status: tab Nodes hilang, Project tetap pilihan awal', () => {
    render(<SessionsPanel {...baseProps()} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['Project', 'Status'])
    expect(screen.getByRole('tab', { name: 'Project' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByRole('tab', { name: 'Nodes' })).toBeNull()
  })
})
