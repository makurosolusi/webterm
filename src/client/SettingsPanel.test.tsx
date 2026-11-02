/**
 * @vitest-environment jsdom
 */
// Settings dalam bentuk VS Code Settings editor: sidebar section, baris label-kiri/kontrol-kanan,
// dan search lintas section. Yang dijaga di sini adalah perilaku yang sudah ada (persistensi lewat
// `onChange`, keyboard Escape, tambah/hapus agent) plus filter pencarian yang baru.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type CustomAgent, type Settings } from '../shared/settings'
import { SettingsPanel } from './SettingsPanel'

afterEach(cleanup)

// Render Settings membangun Dialog + enam section di jsdom; saat suite lain berjalan paralel
// durasinya bisa jauh melewati 5 detik default (load mesin tinggi).
vi.setConfig({ testTimeout: 60_000 })

function renderPanel(overrides: Partial<Settings> = {}) {
  const onChange = vi.fn()
  const onClose = vi.fn()
  const view = render(
    <SettingsPanel settings={{ ...DEFAULT_SETTINGS, ...overrides }} onChange={onChange} onClose={onClose} />,
  )
  return { onChange, onClose, ...view }
}

const nav = () => screen.getByRole('navigation', { name: 'Section settings' })

describe('SettingsPanel VS Code layout', () => {
  it('renders the search box, section sidebar, and the active section as label/control rows', () => {
    renderPanel()

    expect(screen.getByRole('searchbox', { name: 'Cari setting' })).toBeTruthy()
    for (const label of ['Terminal', 'Interaksi', 'Shell & buffer', 'Agent', 'Canvas', 'Preview']) {
      expect(within(nav()).getByRole('button', { name: label })).toBeTruthy()
    }

    expect(screen.getByRole('heading', { level: 2, name: 'Terminal' })).toBeTruthy()
    const fontSize = screen.getByLabelText('Ukuran font') as HTMLInputElement
    expect(fontSize.value).toBe(String(DEFAULT_SETTINGS.fontSize))
    expect(fontSize.closest('[data-slot="settings-field"]')).toBeTruthy()
  })

  it('switches section from the sidebar and keeps the active item marked', () => {
    renderPanel()

    fireEvent.click(within(nav()).getByRole('button', { name: 'Canvas' }))

    expect(screen.getByRole('heading', { level: 2, name: 'Canvas' })).toBeTruthy()
    expect(screen.getByLabelText('Ukuran grid')).toBeTruthy()
    expect(screen.queryByLabelText('Ukuran font')).toBeNull()
    expect(within(nav()).getByRole('button', { name: 'Canvas' }).getAttribute('aria-current')).toBe('true')
  })
})

describe('SettingsPanel persistence', () => {
  it('emits the patch for a number field change', () => {
    const { onChange } = renderPanel()

    fireEvent.change(screen.getByLabelText('Ukuran font'), { target: { value: '18' } })

    expect(onChange).toHaveBeenCalledWith({ fontSize: 18 })
  })

  it('clamps a number on commit without rewriting it per keystroke', () => {
    const { onChange, rerender } = renderPanel()

    fireEvent.change(screen.getByLabelText('Ukuran font'), { target: { value: '2' } })
    expect(onChange).toHaveBeenLastCalledWith({ fontSize: 2 })
    // Parent nyata menerapkan patch; blur membaca nilai terbaru itu, bukan nilai ketikan liar.
    rerender(<SettingsPanel settings={{ ...DEFAULT_SETTINGS, fontSize: 2 }} onChange={onChange} onClose={vi.fn()} />)
    fireEvent.blur(screen.getByLabelText('Ukuran font'))

    expect(onChange).toHaveBeenLastCalledWith({ fontSize: 6 })
  })

  it('toggles through the VS Code switch with the same accessible name', () => {
    const { onChange } = renderPanel()

    const toggle = screen.getByRole('switch', { name: 'Kursor berkedip' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)

    expect(onChange).toHaveBeenCalledWith({ cursorBlink: false })
  })

  it('closes through the header button', () => {
    const { onClose } = renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'Tutup settings' }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('SettingsPanel search', () => {
  it('filters fields across every section instead of only the active one', () => {
    renderPanel()
    fireEvent.click(within(nav()).getByRole('button', { name: 'Canvas' }))

    fireEvent.change(screen.getByRole('searchbox', { name: 'Cari setting' }), { target: { value: 'font' } })

    // Terminal punya field font; Canvas yang sedang aktif tidak.
    expect(screen.getByLabelText('Ukuran font')).toBeTruthy()
    expect(screen.getByLabelText('Font family')).toBeTruthy()
    expect(screen.queryByLabelText('Ukuran grid')).toBeNull()
  })

  it('treats space-separated tokens as AND and reports when nothing matches', () => {
    renderPanel()
    const search = screen.getByRole('searchbox', { name: 'Cari setting' })

    fireEvent.change(search, { target: { value: 'font bold' } })
    expect(screen.getByLabelText('Bobot teks bold')).toBeTruthy()

    fireEvent.change(search, { target: { value: 'tidak-ada-setting-ini' } })
    expect(screen.queryByLabelText('Ukuran font')).toBeNull()
    expect(screen.getByText(/Tidak ada setting yang cocok/)).toBeTruthy()
  })

  it('clears the query on Escape instead of closing the dialog, and clears on section click', () => {
    const { onClose } = renderPanel()
    const search = screen.getByRole('searchbox', { name: 'Cari setting' }) as HTMLInputElement

    fireEvent.change(search, { target: { value: 'font' } })
    fireEvent.keyDown(search, { key: 'Escape' })

    expect(search.value).toBe('')
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { level: 2, name: 'Terminal' })).toBeTruthy()

    fireEvent.change(search, { target: { value: 'grid' } })
    fireEvent.click(within(nav()).getByRole('button', { name: 'Shell & buffer' }))

    expect(search.value).toBe('')
    expect(screen.getByRole('heading', { level: 2, name: 'Shell & buffer' })).toBeTruthy()
  })
})

describe('SettingsPanel agents', () => {
  it('writes a builtin launch command and deletes the key when the field is emptied', () => {
    const { onChange, rerender } = renderPanel()

    fireEvent.click(within(nav()).getByRole('button', { name: 'Agent' }))
    const launch = screen.getByLabelText('Claude Code launch command')
    fireEvent.change(launch, { target: { value: 'wrap-claude' } })
    expect(onChange).toHaveBeenLastCalledWith({ agentLaunchCommands: { claude: 'wrap-claude' } })

    rerender(
      <SettingsPanel
        settings={{ ...DEFAULT_SETTINGS, agentLaunchCommands: { claude: 'wrap-claude' } }}
        onChange={onChange}
        onClose={vi.fn()}
      />,
    )
    fireEvent.click(within(nav()).getByRole('button', { name: 'Agent' }))
    fireEvent.change(screen.getByLabelText('Claude Code launch command'), { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith({ agentLaunchCommands: {} })
  })

  it('adds a custom agent with a stable id prefix', () => {
    const { onChange } = renderPanel()
    fireEvent.click(within(nav()).getByRole('button', { name: 'Agent' }))

    fireEvent.click(screen.getByRole('button', { name: 'Tambah agent' }))

    const patch = onChange.mock.calls[0][0] as Partial<Settings>
    expect(patch.customAgents).toHaveLength(1)
    expect(patch.customAgents?.[0].id).toMatch(/^custom:/)
  })

  it('drops every reference to a removed custom agent', () => {
    const agent: CustomAgent = { id: 'custom:dead', label: 'Proxy', launchCmd: 'proxy' }
    const { onChange } = renderPanel({
      customAgents: [agent],
      defaultAgent: agent.id,
      disabledAgents: [agent.id],
    })
    fireEvent.click(within(nav()).getByRole('button', { name: 'Agent' }))

    fireEvent.click(screen.getByRole('button', { name: 'Hapus' }))

    expect(onChange).toHaveBeenCalledWith({
      customAgents: [],
      defaultAgent: DEFAULT_SETTINGS.defaultAgent,
      disabledAgents: [],
    })
  })
})
