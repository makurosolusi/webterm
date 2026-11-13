/**
 * @vitest-environment jsdom
 */
// Settings in the macOS System Settings / Linear shape: sidebar (search on top, single-line items),
// rows with the label left and the control right, booleans as switches, "Reset page…" in the header.
// Also the behavior that was already there: persistence through `onChange`, Escape, agents add/remove.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type CustomAgent, type Settings } from '../shared/settings'
import { SETTING_RANGES } from '../shared/settings.ranges'
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, SettingsPanel, toSectionId } from './SettingsPanel'

// Tab Kemampuan memuat dari server; tes layout ini tak membutuhkannya (D8 ada di SettingsPanel.capabilities.test.tsx).
vi.mock('./useCapabilities', () => ({
  useCapabilities: () => ({ data: null, loading: false, error: null, errorId: null, busyId: null, refresh: async () => undefined, toggle: async () => true, setSub: async () => true }),
  capabilityErrorMessage: () => '',
}))

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

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
/** Settings opened on Terminal, where the terminal look (font, cursor) lives since it left Appearance. */
function renderTerminal(overrides: Partial<Settings> = {}) {
  const view = renderPanel(overrides)
  fireEvent.click(within(nav()).getByRole('button', { name: 'Terminal' }))
  return view
}

describe('SettingsPanel layout', () => {
  it('fills the viewport without the shadcn centering utilities (prod minifier drops a CSS translate reset)', () => {
    renderPanel()

    const classes = [...document.querySelector('.st-dialog-content')!.classList]
    for (const centering of ['translate-x-[-50%]', 'translate-y-[-50%]', 'top-[50%]', 'left-[50%]']) {
      expect(classes).not.toContain(centering)
    }
    expect(classes).toEqual(expect.arrayContaining(['inset-0', 'translate-x-0', 'translate-y-0']))
  })

  it('renders the search box inside the sidebar column, single-line nav items, and the page as label/control rows', () => {
    renderPanel()

    const search = screen.getByRole('searchbox', { name: 'Search settings' })
    expect(search.closest('.st-sidebar')).toBe(nav().closest('.st-sidebar')) // one column, not a bar over both
    // Developer is hidden outside developer mode (./developerMode). Memory, Automations and Spending moved to the Control panel.
    const labels = ['Appearance', 'Terminal', 'Keyboard Shortcuts', 'Canvas', 'Notifications', 'Claude', 'Central', 'Rules & secrets', 'Account', 'Features', 'About this machine']
    expect(within(nav()).getAllByRole('button').map((b) => b.textContent)).toEqual(labels) // the title only, one line
    expect(labels.map((name) => within(nav()).getByRole('button', { name }))).toHaveLength(labels.length)

    expect(screen.getByRole('heading', { level: 2, name: 'Appearance' })).toBeTruthy()
    fireEvent.click(within(nav()).getByRole('button', { name: 'Terminal' }))
    const fontSize = screen.getByRole('spinbutton', { name: 'Font size' })
    expect(fontSize.getAttribute('aria-valuenow')).toBe(String(DEFAULT_SETTINGS.fontSize))
    const row = fontSize.closest('[data-slot="settings-field"]') as HTMLElement
    // Row anatomy: text column (label + description) first, then the control column.
    expect([...row.children].slice(0, 2).map((c) => c.className)).toEqual(['st-field-text', 'st-control'])
    expect(row.querySelector('.st-control')!.contains(fontSize)).toBe(true)
    expect(row.querySelector('.st-field-text .st-label')?.textContent).toBe('Font size')
    // The page sits in the centred content column.
    expect(row.closest('.st-content')).toBeTruthy()
  })

  it('groups the sidebar under General, Agents and Account & system (no one-item group), in that order', () => {
    renderPanel()
    const groups = within(nav()).getAllByRole('group')
    expect(groups.map((g) => g.getAttribute('aria-labelledby') && document.getElementById(g.getAttribute('aria-labelledby')!)?.textContent))
      .toEqual(['General', 'Agents', 'Account & system'])
    const byGroup = groups.map((g) => within(g).getAllByRole('button').map((b) => b.textContent))
    expect(byGroup).toEqual([
      ['Appearance', 'Terminal', 'Keyboard Shortcuts', 'Canvas', 'Notifications'],
      ['Claude', 'Central', 'Rules & secrets'],
      ['Account', 'Features', 'About this machine'],
    ])
    expect(within(nav()).getByRole('group', { name: 'Account & system' })).toBe(groups[2])
    expect(SETTINGS_GROUPS).toEqual(['General', 'Agents', 'Account & system'])
    // SETTINGS_SECTIONS is listed in group order, so the sidebar order equals the array order.
    expect(SETTINGS_SECTIONS.map((x) => x.group)).toEqual([...SETTINGS_SECTIONS.map((x) => x.group)].sort((a, b) => SETTINGS_GROUPS.indexOf(a) - SETTINGS_GROUPS.indexOf(b)))
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

describe('SettingsPanel section icons and descriptions', () => {
  it('uses outline icons for Account and About (not the filled account / pulse glyphs)', () => {
    const icon = (id: string) => SETTINGS_SECTIONS.find((x) => x.id === id)?.icon
    expect(icon('account')).toBe('person')
    expect(icon('health')).toBe('info')
  })

  it('gives every section a known codicon and a short description', () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(section.icon, section.id).toMatch(/^[a-z-]+$/)
      expect(section.description.length, section.id).toBeGreaterThan(0)
      expect(section.description.length, section.id).toBeLessThanOrEqual(40)
    }
  })

  it('renders a decorative icon and only the title in each nav item; the description is in the page header', () => {
    renderPanel()
    const items = within(nav()).getAllByRole('button')
    const listed = SETTINGS_SECTIONS.filter((x) => x.id !== 'developer') // developer mode off
    expect(items).toHaveLength(listed.length)
    listed.forEach((section, i) => {
      const icon = items[i]!.querySelector('.codicon')!
      expect(icon.classList).toContain(`codicon-${section.icon}`)
      expect(icon.getAttribute('aria-hidden')).toBe('true')
      expect(items[i]!.textContent).toBe(section.label)
      expect(items[i]!.hasAttribute('aria-describedby')).toBe(false)
    })
    expect(document.querySelector('.st-section-desc')?.textContent).toBe(SETTINGS_SECTIONS[0].description)
  })

  it('shows the same icon, title and description in the section header, for every section id', () => {
    // The purpose sections load from the server; a 404 is enough here, the header does not wait for them.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"not_found"}', { status: 404 })))
    renderPanel()
    for (const section of SETTINGS_SECTIONS.filter((x) => x.id !== 'capabilities' && x.id !== 'developer')) {
      fireEvent.click(within(nav()).getByRole('button', { name: section.label }))
      const heading = screen.getByRole('heading', { level: 2, name: section.label })
      expect(heading.querySelector('.codicon')?.classList).toContain(`codicon-${section.icon}`)
      expect(heading.querySelector('.codicon')?.getAttribute('aria-hidden')).toBe('true')
      expect(heading.closest('.st-section-head')?.querySelector('.st-section-desc')?.textContent).toBe(section.description)
    }
  })
})

describe('SettingsPanel item placement', () => {
  it('Appearance holds theme and canvas background; Terminal holds the look (preview, colors, font, cursor) and History length; Canvas holds the grid', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')))
    renderPanel()
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeTruthy()
    expect(document.querySelector('[data-field="canvasBackground"]')).toBeTruthy()
    for (const moved of ['Terminal colors', 'Font size', 'Cursor blink']) expect(screen.queryByLabelText(moved), moved).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Font' })).toBeNull()

    fireEvent.click(within(nav()).getByRole('button', { name: 'Terminal' }))
    expect(screen.getByTestId('terminal-preview')).toBeTruthy()
    expect(screen.getByLabelText('Terminal colors')).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Font' })).toBeTruthy()
    expect(screen.getByRole('radiogroup', { name: 'Cursor style' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'History length' })).toBeTruthy()
    expect(screen.queryByRole('radiogroup', { name: 'Theme' })).toBeNull()

    fireEvent.click(within(nav()).getByRole('button', { name: 'Canvas' }))
    expect(screen.getByRole('radiogroup', { name: 'Grid' })).toBeTruthy()
    expect(screen.queryByRole('radiogroup', { name: 'Theme' })).toBeNull()
  })

  it('a link with an old section id lands on the page that now holds the field', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')))
    render(<SettingsPanel settings={DEFAULT_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} section="appearance" field="fontSize" />)
    expect(screen.getByRole('heading', { level: 2, name: 'Terminal' })).toBeTruthy() // the look moved to Terminal; old links follow
    cleanup()
    render(<SettingsPanel settings={DEFAULT_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} section="shell" field="defaultProjectsFolder" />)
    expect(screen.getByRole('heading', { level: 2, name: 'Canvas' })).toBeTruthy()
    cleanup()
    render(<SettingsPanel settings={DEFAULT_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} section="canvas" field="browserSearchEngine" />)
    expect(screen.getByRole('heading', { level: 2, name: 'Features' })).toBeTruthy()
  })

  it('falls back to Appearance for an unknown or legacy tab id', () => {
    expect(toSectionId('preview')).toBe('appearance')
    expect(toSectionId('nope')).toBe('appearance')
    expect(toSectionId('canvas')).toBe('canvas')
    expect(toSectionId('interaction')).toBe('terminal')
    expect(toSectionId('shell')).toBe('terminal')
    expect(toSectionId('background')).toBe('appearance')
    expect(toSectionId('env')).toBe('capabilities')
    expect(toSectionId('channels')).toBe('capabilities')
    expect(toSectionId('control')).toBe('health')
    for (const section of SETTINGS_SECTIONS) expect(toSectionId(section.id)).toBe(section.id)
  })

  it('Developer shows in the nav only in developer mode (About this machine switch), and a link opens it anyway', async () => {
    const { resetDeveloperModeCache, writeDeveloperMode } = await import('./developerMode')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"not_found"}', { status: 404 })))
    resetDeveloperModeCache()
    writeDeveloperMode(false)
    renderPanel()
    expect(within(nav()).queryByRole('button', { name: 'Developer' })).toBeNull()
    fireEvent.click(within(nav()).getByRole('button', { name: 'About this machine' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Show developer tools' }))
    expect(screen.getByText('Saved on this browser').closest('[role="status"]')).toBeTruthy() // local pref, said so
    expect(within(nav()).getByRole('button', { name: 'Developer' })).toBeTruthy()
    writeDeveloperMode(false)
    cleanup()
    render(<SettingsPanel settings={DEFAULT_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} initialSection="developer" />)
    expect(screen.getByRole('heading', { level: 2, name: 'Developer' })).toBeTruthy()
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
    // Across a group heading: the last General item steps down into the first Agents item.
    items[4]!.focus()
    fireEvent.keyDown(items[4]!, { key: 'ArrowDown' })
    expect(document.activeElement?.textContent).toContain('Claude')
    expect(document.activeElement).toBe(items[5])
  })
})

describe('SettingsPanel persistence', () => {
  it('emits the patch for a stepper change (buttons and arrow keys)', () => {
    const { onChange } = renderTerminal()

    fireEvent.click(screen.getByRole('button', { name: 'Increase Font size' }))
    expect(onChange).toHaveBeenLastCalledWith({ fontSize: DEFAULT_SETTINGS.fontSize + 1 })
    fireEvent.keyDown(screen.getByRole('spinbutton', { name: 'Font size' }), { key: 'ArrowDown' })
    expect(onChange).toHaveBeenLastCalledWith({ fontSize: DEFAULT_SETTINGS.fontSize - 1 })
  })

  it('the stepper stops at the setting range', () => {
    const { onChange, rerender } = renderTerminal()

    fireEvent.keyDown(screen.getByRole('spinbutton', { name: 'Font size' }), { key: 'End' })
    expect(onChange).toHaveBeenLastCalledWith({ fontSize: SETTING_RANGES.fontSize.max })
    rerender(<SettingsPanel settings={{ ...DEFAULT_SETTINGS, fontSize: SETTING_RANGES.fontSize.max }} onChange={onChange} onClose={vi.fn()} />)
    expect((screen.getByRole('button', { name: 'Increase Font size' }) as HTMLButtonElement).disabled).toBe(true)
    onChange.mockClear()
    fireEvent.keyDown(screen.getByRole('spinbutton', { name: 'Font size' }), { key: 'PageUp' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('toggles a boolean through a switch in the control column, named by the row label', () => {
    const { onChange } = renderTerminal()

    const toggle = screen.getByRole('switch', { name: 'Cursor blink' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(toggle.closest('.st-control')).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: 'Cursor blink' })).toBeNull()
    fireEvent.click(toggle)

    expect(onChange).toHaveBeenCalledWith({ cursorBlink: false })
  })

  it('outside search: no page prefix, a modified dot and a visible Reset that resets the item', () => {
    const { onChange } = renderTerminal({ cursorBlink: false })

    const field = screen.getByLabelText('Cursor blink').closest('[data-slot="settings-field"]') as HTMLElement
    expect(within(field).getByText('(Modified)')).toBeTruthy()
    expect(field.querySelector('.st-category')).toBeNull() // the prefix belongs to search results only

    fireEvent.click(within(field).getByRole('button', { name: 'Reset Setting: Cursor blink' }))

    expect(onChange).toHaveBeenCalledWith({ cursorBlink: DEFAULT_SETTINGS.cursorBlink })
    expect(screen.queryByRole('alertdialog')).toBeNull() // a scalar resets instantly, no confirm
  })

  it('does not show Modified or a reset gear for a default value', () => {
    renderTerminal()

    const field = screen.getByLabelText('Cursor blink').closest('[data-slot="settings-field"]') as HTMLElement
    expect(within(field).queryByText('(Modified)')).toBeNull()
    expect(within(field).queryByRole('button', { name: /Reset Setting/ })).toBeNull()
  })

  it('renders every dropdown as the same native select with a codicon chevron', () => {
    const { onChange } = renderTerminal()

    const select = screen.getByLabelText('Terminal colors') as HTMLSelectElement
    expect(select.tagName).toBe('SELECT')
    expect(select.className).toBe('st-select')
    expect(select.parentElement?.querySelector('.codicon-chevron-down')).toBeTruthy()
    fireEvent.change(select, { target: { value: 'dracula' } })

    expect(onChange).toHaveBeenCalledWith({ terminalTheme: 'dracula' })
  })

  it('one modified indicator per row: the dot, no left bar element; Reset page… resets the page after a confirm', () => {
    const { onChange } = renderTerminal({ cursorBlink: false, fontSize: DEFAULT_SETTINGS.fontSize + 2 })
    const field = screen.getByLabelText('Cursor blink').closest('[data-slot="settings-field"]') as HTMLElement
    expect(field.querySelectorAll('.st-modified-dot')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Reset page…' }))
    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByText('Reset 2 settings on Terminal?')).toBeTruthy()
    expect(dialog.textContent).toContain('Font size')
    expect(dialog.textContent).toContain('Cursor blink')
    expect(onChange).not.toHaveBeenCalled() // nothing until confirmed
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset' }))
    expect(onChange).toHaveBeenCalledWith({ fontSize: DEFAULT_SETTINGS.fontSize, cursorBlink: DEFAULT_SETTINGS.cursorBlink })
  })

  it('no Reset page… when the page is at its defaults', () => {
    renderPanel()
    expect(screen.queryByRole('button', { name: 'Reset page…' })).toBeNull()
  })

  it('lists agents of the Add menu as checkboxes, not toggle chips', () => {
    const { onChange } = renderPanel({ disabledAgents: [] })
    fireEvent.click(within(nav()).getByRole('button', { name: 'Claude' }))

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

describe('SettingsPanel agents', () => {
  it('Escape in the launch profile editor cancels the editor, not the Settings dialog', () => {
    const { onClose } = renderPanel()
    fireEvent.click(within(nav()).getByRole('button', { name: 'Claude' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add profile' }))
    const name = screen.getByLabelText('Name')
    expect(document.activeElement).toBe(name)
    fireEvent.keyDown(name, { key: 'Escape' })
    expect(screen.queryByRole('form', { name: 'New launch profile' })).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Add profile' })).toBeTruthy()
  })

  it('has no per-CLI launch command rows; Claude is configured through launch profiles and the base picker offers Claude only', () => {
    const agent: CustomAgent = { id: 'custom:p', label: 'Proxy', launchCmd: '', baseAgent: 'claude' }
    render(<SettingsPanel settings={{ ...DEFAULT_SETTINGS, customAgents: [agent] }} onChange={vi.fn()} onClose={vi.fn()} />)
    fireEvent.click(within(nav()).getByRole('button', { name: 'Claude' }))
    for (const label of ['Codex', 'Gemini', 'Claude Code']) expect(screen.queryByLabelText(`${label} launch command`)).toBeNull()
    expect(screen.getByRole('region', { name: 'Default' })).toBeTruthy()
    // The Agents-in-Add-menu checklist lists Claude Code and the custom agent, no retired CLI.
    expect(screen.queryByText('Codex')).toBeNull()
    expect(screen.getAllByText('Claude Code').length).toBeGreaterThan(0)
  })

  it('adds a custom agent with a stable id prefix', () => {
    const { onChange } = renderPanel()
    fireEvent.click(within(nav()).getByRole('button', { name: 'Claude' }))

    fireEvent.click(screen.getByRole('button', { name: 'Add agent' }))

    const patch = onChange.mock.calls[0][0] as Partial<Settings>
    expect(patch.customAgents).toHaveLength(1)
    expect(patch.customAgents?.[0].id).toMatch(/^custom:/)
  })

  it('drops every reference to a removed custom agent', () => {
    const agent: CustomAgent = { id: 'custom:dead', label: 'Proxy', launchCmd: 'proxy' }
    const { onChange } = renderPanel({
      customAgents: [agent],
      disabledAgents: [agent.id],
    })
    fireEvent.click(within(nav()).getByRole('button', { name: 'Claude' }))

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

    expect(onChange).toHaveBeenCalledWith({
      customAgents: [],
      disabledAgents: [],
    })
  })
})
