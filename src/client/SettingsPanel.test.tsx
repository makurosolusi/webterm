/**
 * @vitest-environment jsdom
 */
// Settings dalam bentuk VS Code Settings editor: sidebar section, baris label-kiri/kontrol-kanan,
// dan search lintas section. Yang dijaga di sini adalah perilaku yang sudah ada (persistensi lewat
// `onChange`, keyboard Escape, tambah/hapus agent) plus filter pencarian yang baru.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type CustomAgent, type Settings } from '../shared/settings'
import { SettingsPanel, toSectionId } from './SettingsPanel'

// Tab Kemampuan memuat dari server; tes layout ini tak membutuhkannya (D8 ada di SettingsPanel.capabilities.test.tsx).
vi.mock('./useCapabilities', () => ({
  useCapabilities: () => ({ data: null, loading: false, error: null, busyId: null, refresh: async () => undefined, toggle: async () => true, setSub: async () => true }),
  capabilityErrorMessage: () => '',
}))

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

    expect(screen.getByRole('searchbox', { name: 'Search settings' })).toBeTruthy()
    const labels = ['Terminal', 'Interaction', 'Shell & buffer', 'Agent', 'Canvas', 'Canvas background', 'Capabilities', 'Control']
    expect(within(nav()).getAllByRole('button').map((b) => b.textContent)).toEqual(labels)

    expect(screen.getByRole('heading', { level: 2, name: 'Terminal' })).toBeTruthy()
    const fontSize = screen.getByLabelText('Font size') as HTMLInputElement
    expect(fontSize.value).toBe(String(DEFAULT_SETTINGS.fontSize))
    expect(fontSize.closest('[data-slot="settings-field"]')).toBeTruthy()
  })

  it('switches section from the sidebar and keeps the active item marked', () => {
    renderPanel()

    fireEvent.click(within(nav()).getByRole('button', { name: 'Canvas' }))

    expect(screen.getByRole('heading', { level: 2, name: 'Canvas' })).toBeTruthy()
    expect(screen.getByLabelText('Grid size')).toBeTruthy()
    expect(screen.queryByLabelText('Font size')).toBeNull()
    expect(within(nav()).getByRole('button', { name: 'Canvas' }).getAttribute('aria-current')).toBe('true')
  })
})

describe('SettingsPanel item placement', () => {
  it('puts scrollback lines and the app theme in Terminal, not Shell or Canvas', () => {
    renderPanel()
    expect(screen.getByLabelText('Terminal scrollback')).toBeTruthy()
    expect(screen.getByLabelText('App theme')).toBeTruthy()
    expect(screen.getByLabelText('Color scheme')).toBeTruthy()

    fireEvent.click(within(nav()).getByRole('button', { name: 'Shell & buffer' }))
    expect(screen.queryByLabelText('Terminal scrollback')).toBeNull()
    expect(screen.getByLabelText('Server replay buffer')).toBeTruthy()

    fireEvent.click(within(nav()).getByRole('button', { name: 'Canvas' }))
    expect(screen.queryByLabelText('App theme')).toBeNull()
    expect(screen.queryByLabelText('Warna aksen')).toBeNull()
  })

  it('puts the Markdown preview toggle in Interaksi', () => {
    renderPanel()
    expect(screen.queryByLabelText('Open Markdown as preview')).toBeNull()

    fireEvent.click(within(nav()).getByRole('button', { name: 'Interaction' }))

    expect(screen.getByLabelText('Open Markdown as preview')).toBeTruthy()
  })

  it('falls back to terminal for an unknown or legacy tab id', () => {
    expect(toSectionId('preview')).toBe('terminal')
    expect(toSectionId('nope')).toBe('terminal')
    expect(toSectionId('canvas')).toBe('canvas')
    expect(toSectionId('env')).toBe('capabilities')
    expect(toSectionId('channels')).toBe('capabilities')
  })
})

describe('SettingsPanel keyboard', () => {
  it('moves focus through the section list with arrow keys, Home and End', () => {
    renderPanel()
    const items = within(nav()).getAllByRole('button')
    items[0]!.focus()

    fireEvent.keyDown(items[0]!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[1])
    fireEvent.keyDown(items[1]!, { key: 'End' })
    expect(document.activeElement).toBe(items[items.length - 1])
    fireEvent.keyDown(items[items.length - 1]!, { key: 'Home' })
    expect(document.activeElement).toBe(items[0])
  })
})

describe('SettingsPanel persistence', () => {
  it('emits the patch for a number field change', () => {
    const { onChange } = renderPanel()

    fireEvent.change(screen.getByLabelText('Font size'), { target: { value: '18' } })

    expect(onChange).toHaveBeenCalledWith({ fontSize: 18 })
  })

  it('clamps a number on commit without rewriting it per keystroke', () => {
    const { onChange, rerender } = renderPanel()

    fireEvent.change(screen.getByLabelText('Font size'), { target: { value: '2' } })
    expect(onChange).toHaveBeenLastCalledWith({ fontSize: 2 })
    // Parent nyata menerapkan patch; blur membaca nilai terbaru itu, bukan nilai ketikan liar.
    rerender(<SettingsPanel settings={{ ...DEFAULT_SETTINGS, fontSize: 2 }} onChange={onChange} onClose={vi.fn()} />)
    fireEvent.blur(screen.getByLabelText('Font size'))

    expect(onChange).toHaveBeenLastCalledWith({ fontSize: 6 })
  })

  it('toggles a boolean through a native checkbox with the same accessible name', () => {
    const { onChange } = renderPanel()

    const toggle = screen.getByRole('checkbox', { name: 'Cursor blink' }) as HTMLInputElement
    expect(toggle.checked).toBe(true)
    fireEvent.click(toggle)

    expect(onChange).toHaveBeenCalledWith({ cursorBlink: false })
  })

  it('shows the category prefix, marks a modified item and resets it through the gear', () => {
    const { onChange } = renderPanel({ cursorBlink: false })

    const field = screen.getByLabelText('Cursor blink').closest('[data-slot="settings-field"]') as HTMLElement
    expect(within(field).getByText('(Modified)')).toBeTruthy()
    expect(field.querySelector('.st-category')?.textContent).toBe('Terminal: ')

    fireEvent.click(within(field).getByRole('button', { name: 'Reset Setting: Cursor blink' }))

    expect(onChange).toHaveBeenCalledWith({ cursorBlink: DEFAULT_SETTINGS.cursorBlink })
  })

  it('does not show Modified or a reset gear for a default value', () => {
    renderPanel()

    const field = screen.getByLabelText('Cursor blink').closest('[data-slot="settings-field"]') as HTMLElement
    expect(within(field).queryByText('(Modified)')).toBeNull()
    expect(within(field).queryByRole('button', { name: /Reset Setting/ })).toBeNull()
  })

  it('renders every dropdown as the same native select with a codicon chevron', () => {
    const { onChange } = renderPanel()

    const select = screen.getByLabelText('Cursor style') as HTMLSelectElement
    expect(select.tagName).toBe('SELECT')
    expect(select.className).toBe('st-select')
    expect(select.parentElement?.querySelector('.codicon-chevron-down')).toBeTruthy()
    fireEvent.change(select, { target: { value: 'bar' } })

    expect(onChange).toHaveBeenCalledWith({ cursorStyle: 'bar' })
  })

  it('draws checkboxes as a codicon check inside the 18px box', () => {
    renderPanel()

    const toggle = screen.getByRole('checkbox', { name: 'Cursor blink' })
    expect(toggle.nextElementSibling?.className).toBe('st-checkbox-box')
    expect(toggle.nextElementSibling?.querySelector('.codicon-check')).toBeTruthy()
  })

  it('lists agents of the Add menu as checkboxes, not toggle chips', () => {
    const { onChange } = renderPanel({ disabledAgents: [] })
    fireEvent.click(within(nav()).getByRole('button', { name: 'Agent' }))

    expect(document.querySelector('.st-chip')).toBeNull()
    const [first] = document.querySelectorAll<HTMLInputElement>('.st-checkrow input[type="checkbox"]')
    expect(first!.checked).toBe(true)
    fireEvent.click(first!)

    expect(onChange.mock.calls.at(-1)?.[0].disabledAgents).toHaveLength(1)
  })

  it('closes through the header button', () => {
    const { onClose } = renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('SettingsPanel search', () => {
  it('reports the number of matching settings and clears through the clear button', () => {
    renderPanel()
    const search = screen.getByRole('searchbox', { name: 'Search settings' }) as HTMLInputElement

    fireEvent.change(search, { target: { value: 'font' } })
    const count = document.querySelector('.st-search-count') as HTMLElement
    expect(count.textContent).toMatch(/^\d+ settings? found$/)
    expect(Number.parseInt(count.textContent ?? '', 10)).toBe(
      document.querySelectorAll('[data-slot="settings-field"]').length,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(search.value).toBe('')
  })

  it('filters fields across every section instead of only the active one', () => {
    renderPanel()
    fireEvent.click(within(nav()).getByRole('button', { name: 'Canvas' }))

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'font' } })

    // Terminal punya field font; Canvas yang sedang aktif tidak.
    expect(screen.getByLabelText('Font size')).toBeTruthy()
    expect(screen.getByLabelText('Font family')).toBeTruthy()
    expect(screen.queryByLabelText('Grid size')).toBeNull()
  })

  it('treats space-separated tokens as AND and reports when nothing matches', () => {
    renderPanel()
    const search = screen.getByRole('searchbox', { name: 'Search settings' })

    fireEvent.change(search, { target: { value: 'font bold' } })
    expect(screen.getByLabelText('Bold text weight')).toBeTruthy()

    fireEvent.change(search, { target: { value: 'tidak-ada-setting-ini' } })
    expect(screen.queryByLabelText('Font size')).toBeNull()
    expect(screen.getByText(/Tidak ada setting yang cocok/)).toBeTruthy()
  })

  it('clears the query on Escape instead of closing the dialog, and clears on section click', () => {
    const { onClose } = renderPanel()
    const search = screen.getByRole('searchbox', { name: 'Search settings' }) as HTMLInputElement

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
    const launch = screen.getByLabelText('Codex launch command')
    fireEvent.change(launch, { target: { value: 'wrap-codex' } })
    expect(onChange).toHaveBeenLastCalledWith({ agentLaunchCommands: { codex: 'wrap-codex' } })

    rerender(
      <SettingsPanel
        settings={{ ...DEFAULT_SETTINGS, agentLaunchCommands: { codex: 'wrap-codex' } }}
        onChange={onChange}
        onClose={vi.fn()}
      />,
    )
    fireEvent.click(within(nav()).getByRole('button', { name: 'Agent' }))
    fireEvent.change(screen.getByLabelText('Codex launch command'), { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith({ agentLaunchCommands: {} })
    // Claude has no row here any more: it is configured through the launch profiles card.
    expect(screen.queryByLabelText('Claude Code launch command')).toBeNull()
    expect(screen.getByRole('region', { name: 'Default' })).toBeTruthy()
  })

  it('adds a custom agent with a stable id prefix', () => {
    const { onChange } = renderPanel()
    fireEvent.click(within(nav()).getByRole('button', { name: 'Agent' }))

    fireEvent.click(screen.getByRole('button', { name: 'Add agent' }))

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

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

    expect(onChange).toHaveBeenCalledWith({
      customAgents: [],
      defaultAgent: DEFAULT_SETTINGS.defaultAgent,
      disabledAgents: [],
    })
  })
})
