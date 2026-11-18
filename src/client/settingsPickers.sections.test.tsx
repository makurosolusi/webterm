/** @vitest-environment jsdom */
// Each converted settings screen uses the low-typing control its value calls for: steppers, sliders
// and selects for bounded numbers, the remembering combobox for free input, password boxes for secrets.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/settings'
import type { EffectiveRow } from './ControlPanel'
import { ControlField } from './ControlPanelField'
import { PolicySimulator } from './PolicySimulator'
import { CustomAgentsSettings } from './SettingsAgents'
import { CanvasSection } from './SettingsCanvasSections'
import { AppearanceSection } from './SettingsAppearanceSection'
import { TerminalSection } from './SettingsTerminalSections'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const combo = (name: string) => screen.getByRole('combobox', { name }) as HTMLInputElement
const select = (name: string) => screen.getByLabelText(name) as HTMLSelectElement
const optionsOf = (name: string): string[] => {
  fireEvent.click(within(combo(name).closest('.st-combo') as HTMLElement).getByRole('button', { name: 'Show suggestions' }))
  return within(combo(name).closest('.st-combo') as HTMLElement).getAllByRole('option').map((o) => o.textContent ?? '')
}

describe('settings pickers per screen', () => {
  it('Appearance: Theme is a Light/Dark/System segmented choice; the terminal look is not here', () => {
    const onChange = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')))
    render(<AppearanceSection settings={DEFAULT_SETTINGS} onChange={onChange} />)
    const theme = screen.getByRole('radiogroup', { name: 'Theme' })
    expect(within(theme).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Light', 'Dark', 'System'])
    expect(within(theme).getByRole('radio', { name: 'System' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(theme).getByRole('radio', { name: 'Dark' }))
    expect(onChange).toHaveBeenLastCalledWith({ appTheme: 'dark' })
    for (const moved of ['Font size', 'Terminal colors', 'Cursor blink']) expect(screen.queryByText(moved), moved).toBeNull()
    expect(document.querySelectorAll('[data-slot="settings-group"]').length).toBe(3) // Theme, Layout (header mode), Canvas background
    expect(document.querySelector('h4')).toBeNull()
  })

  it('Terminal › Look: preview first, font size a stepper, fonts by family name, cursor style a segmented choice with glyphs', () => {
    const onChange = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')))
    render(<TerminalSection settings={DEFAULT_SETTINGS} onChange={onChange} />)
    const [look, behavior] = [...document.querySelectorAll<HTMLElement>('[data-slot="settings-group"]')]
    expect(look!.querySelector('.st-group-title')?.textContent).toBe('Look')
    expect(look!.querySelector('[data-slot="settings-field"]')?.querySelector('[data-testid="terminal-preview"]')).toBeTruthy()
    expect(behavior!.querySelector('.st-group-title')?.textContent).toBe('Behavior')
    expect(within(look!).getByRole('spinbutton', { name: 'Font size' })).toBeTruthy()
    // At rest the Font box shows the family name, never the CSS stack.
    expect(combo('Font').value).not.toContain(',')
    expect(optionsOf('Font')[0]).toMatch(/\(default\)$/)
    const cursor = within(look!).getByRole('radiogroup', { name: 'Cursor style' })
    expect(within(cursor).getAllByRole('radio').map((r) => r.textContent)).toEqual(['█Block', '▏Bar', '▁Underline'])
    fireEvent.click(within(cursor).getByRole('radio', { name: /Underline/ }))
    expect(onChange).toHaveBeenLastCalledWith({ cursorStyle: 'underline' })
    expect(within(look!).getByLabelText('Normal text weight')).toBeTruthy()
    expect([...select('Normal text weight').options].find((o) => o.value === '400')?.textContent).toBe('Normal (400)')
    expect(screen.getByLabelText('Line height').closest('.st-slider')?.querySelector('output')?.textContent).toBe('1.0×')
  })

  it('Terminal: Shortcut priority is webterm / Terminal program over the stored values; History length reads "10,000 lines"', () => {
    const onChange = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')))
    render(<TerminalSection settings={DEFAULT_SETTINGS} onChange={onChange} />)
    const priority = screen.getByRole('radiogroup', { name: 'Shortcut priority' })
    expect(within(priority).getAllByRole('radio').map((r) => r.textContent)).toEqual(['webterm', 'Terminal program'])
    fireEvent.click(within(priority).getByRole('radio', { name: 'Terminal program' }))
    expect(onChange).toHaveBeenLastCalledWith({ terminalShortcutPolicy: 'terminal-first' })
    expect(combo('History length').value).toBe('10,000 lines (default)')
    cleanup()
    render(<TerminalSection settings={{ ...DEFAULT_SETTINGS, scrollbackLines: 25_000 }} onChange={onChange} />)
    expect(combo('History length').value).toBe('25,000 lines')
  })

  it('Terminal: History length drives both buffers; the rest is under Advanced; shells come from the server', async () => {
    const onChange = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/settings/shells' ? { shells: ['/bin/zsh', '/opt/homebrew/bin/fish'] } : {}))))
    render(<TerminalSection settings={DEFAULT_SETTINGS} onChange={onChange} />)
    expect(select('Normal text weight').tagName).toBe('SELECT')
    expect(select('Normal text weight').closest('details')).toBeNull() // weights are part of the Look now
    expect(screen.getByLabelText('Word separators').closest('details')).not.toBeNull()
    expect(screen.getByRole('switch', { name: 'Draw bold text in bright colors' }).closest('details')).not.toBeNull()
    expect([...select('Bold text weight').options].map((o) => o.value)).toEqual(['100', '200', '300', '400', '500', '600', '700', '800', '900'])
    for (const name of ['Line height', 'Letter spacing', 'Minimum contrast']) expect((screen.getByLabelText(name) as HTMLInputElement).type).toBe('range')
    fireEvent.change(screen.getByLabelText('Line height'), { target: { value: '1.5' } })
    expect(onChange).toHaveBeenLastCalledWith({ terminalLineHeight: 1.5 })
    expect(optionsOf('History length')).toContain('10,000 lines (default)10000')
    fireEvent.change(combo('History length'), { target: { value: '7' } })
    fireEvent.keyDown(combo('History length'), { key: 'Enter' })
    expect(screen.getByRole('alert').textContent).toContain('between 1000 and 100000')
    fireEvent.change(combo('History length'), { target: { value: '20000' } })
    fireEvent.keyDown(combo('History length'), { key: 'Enter' })
    expect(onChange).toHaveBeenLastCalledWith({ scrollbackLines: 20000, scrollbackBytes: 2 * DEFAULT_SETTINGS.scrollbackBytes })
    fireEvent.change(combo('Word separators'), { target: { value: '()' } })
    fireEvent.blur(combo('Word separators'))
    expect(onChange).toHaveBeenLastCalledWith({ terminalWordSeparator: ' ()' })
    await waitFor(() => expect(optionsOf('Default shell')).toEqual(['System default shell', '/bin/zsh', '/opt/homebrew/bin/fish']))
    for (const gone of ['GPU rendering', 'Inactive cursor style', 'Middle-click paste', 'Open Markdown as preview', 'Server replay buffer']) {
      expect(screen.queryByText(gone), gone).toBeNull()
    }
  })

  it('Canvas section: one Grid segmented choice over dots + snap; grid size a select; no node-size settings', () => {
    const onChange = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')))
    render(<CanvasSection settings={DEFAULT_SETTINGS} onChange={onChange} />)
    const grid = screen.getByRole('radiogroup', { name: 'Grid' })
    expect(within(grid).getByRole('radio', { name: 'Dots' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(grid).getByRole('radio', { name: 'Dots and snap' }))
    expect(onChange).toHaveBeenLastCalledWith({ canvasDots: true, snapToGrid: true })
    fireEvent.click(within(grid).getByRole('radio', { name: 'Off' }))
    expect(onChange).toHaveBeenLastCalledWith({ canvasDots: false, snapToGrid: false })
    expect(select('Grid size').tagName).toBe('SELECT')
    expect(screen.queryByText('New node width')).toBeNull()
    expect(screen.queryByText('Search engine')).toBeNull()
    expect([...document.querySelectorAll('[data-slot="settings-group"] .st-group-title')].map((h) => h.textContent)).toEqual(['Nodes', 'New projects'])
    // A hand-edited value outside the presets stays visible and selected.
    cleanup()
    render(<CanvasSection settings={{ ...DEFAULT_SETTINGS, gridSize: 30 }} onChange={onChange} />)
    expect(select('Grid size').value).toBe('30')
  })

  it('Canvas section: cable color swatches + native custom picker, cable thickness select', () => {
    const onChange = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')))
    render(<CanvasSection settings={DEFAULT_SETTINGS} onChange={onChange} />)
    expect(screen.getByRole('button', { name: 'Default' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Teal' }))
    expect(onChange).toHaveBeenLastCalledWith({ edgeColor: '#14b8a6' })
    const custom = screen.getByLabelText('Custom cable color') as HTMLInputElement
    expect(custom.type).toBe('color')
    fireEvent.change(custom, { target: { value: '#123456' } })
    expect(onChange).toHaveBeenLastCalledWith({ edgeColor: '#123456' })
    fireEvent.click(screen.getByRole('button', { name: 'Default' }))
    expect(onChange).toHaveBeenLastCalledWith({ edgeColor: 'default' })
    expect([...select('Cable thickness').options].map((o) => o.value)).toEqual(['1', '1.5', '2', '3', '4'])
    expect(select('Cable thickness').value).toBe('2')
    fireEvent.change(select('Cable thickness'), { target: { value: '3' } })
    expect(onChange).toHaveBeenLastCalledWith({ edgeWidth: 3 })
  })

  it('Agents: a custom agent launch command is a combobox offering claude', () => {
    const onChange = vi.fn()
    render(<CustomAgentsSettings settings={{ ...DEFAULT_SETTINGS, customAgents: [{ id: 'custom:x', label: 'X', launchCmd: '' }] }} onChange={onChange} />)
    expect(optionsOf('Launch command')).toEqual(['claude'])
    fireEvent.click(screen.getByRole('option', { name: 'claude' }))
    expect(onChange).toHaveBeenCalledWith({ customAgents: [{ id: 'custom:x', label: 'X', launchCmd: 'claude' }] })
    expect((screen.getByLabelText('Label') as HTMLInputElement).getAttribute('role')).toBeNull()
  })

  it('Control rows: text/number are comboboxes with the default as a suggestion; secrets stay password boxes', async () => {
    const row = (over: Partial<EffectiveRow>): EffectiveRow => ({
      key: 'WEBTERM_X', label: 'X', description: '', subsystem: 's', value: '', secret: false, source: 'default', reason: '', modified: false,
      ui: null, kind: 'number', editable: true, restart: 'none', setting: '', default: '500', pendingRestart: false, ...over,
    })
    const write = vi.fn(async () => null)
    render(<ControlField row={row({})} write={write} />)
    expect(optionsOf('X')).toEqual(['500 (default)500'])
    fireEvent.change(combo('X'), { target: { value: 'many' } })
    fireEvent.keyDown(combo('X'), { key: 'Enter' })
    expect(screen.getByRole('alert').textContent).toBe('Enter a number.')
    expect(write).not.toHaveBeenCalled()
    cleanup()
    render(<ControlField row={row({ key: 'WEBTERM_SECRET', label: 'Secret', kind: 'secret', secret: true })} write={write} />)
    expect((screen.getByLabelText('Secret') as HTMLInputElement).type).toBe('password')
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('Policy simulator: subject is a select of principals; capability and scope offer known patterns', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ central: false, permissions: false }))))
    render(<PolicySimulator />)
    expect([...select('Who').options].map((o) => o.value)).toEqual(['node:*', 'central', 'routine:*', 'telegram:*', '*'])
    expect(optionsOf('What')).toContain('Click and type in web pagesbrowser.act')
    expect(optionsOf('Where')[0]).toBe('Anywhere*')
  })
})
