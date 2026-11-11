/** @vitest-environment jsdom */
// Each converted settings screen uses the low-typing control its value calls for: steppers, sliders
// and selects for bounded numbers, the remembering combobox for free input, password boxes for secrets.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/settings'
import type { EffectiveRow } from './ControlPanel'
import { ControlField } from './ControlPanelField'
import { CostPanel, COST_API_PATH } from './CostPanel'
import { PolicySimulator } from './PolicySimulator'
import { AgentSettings } from './SettingsAgents'
import { CanvasSection } from './SettingsCanvasSections'
import { InteractionSection, ShellSection, TerminalSection } from './SettingsTerminalSections'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const combo = (name: string) => screen.getByRole('combobox', { name }) as HTMLInputElement
const select = (name: string) => screen.getByLabelText(name) as HTMLSelectElement
const optionsOf = (name: string): string[] => {
  fireEvent.click(within(combo(name).closest('.st-combo') as HTMLElement).getByRole('button', { name: 'Show suggestions' }))
  return within(combo(name).closest('.st-combo') as HTMLElement).getAllByRole('option').map((o) => o.textContent ?? '')
}

describe('settings pickers per screen', () => {
  it('Terminal sections: stepper, combobox, selects and sliders', () => {
    const onChange = vi.fn()
    render(<><TerminalSection settings={DEFAULT_SETTINGS} onChange={onChange} /><InteractionSection settings={DEFAULT_SETTINGS} onChange={onChange} />
      <ShellSection settings={DEFAULT_SETTINGS} onChange={onChange} /></>)
    expect(screen.getByRole('spinbutton', { name: 'Font size' })).toBeTruthy()
    expect(optionsOf('Font family').some((o) => o.startsWith('JetBrains Mono'))).toBe(true)
    expect(select('Normal text weight').tagName).toBe('SELECT')
    expect([...select('Bold text weight').options].map((o) => o.value)).toEqual(['100', '200', '300', '400', '500', '600', '700', '800', '900'])
    for (const name of ['Line height', 'Letter spacing', 'Minimum contrast']) expect((screen.getByLabelText(name) as HTMLInputElement).type).toBe('range')
    fireEvent.change(screen.getByLabelText('Line height'), { target: { value: '1.5' } })
    expect(onChange).toHaveBeenLastCalledWith({ terminalLineHeight: 1.5 })
    expect(optionsOf('Terminal scrollback')).toContain('10,000 lines (default)10000')
    fireEvent.change(combo('Terminal scrollback'), { target: { value: '7' } })
    fireEvent.keyDown(combo('Terminal scrollback'), { key: 'Enter' })
    expect(screen.getByRole('alert').textContent).toContain('between 1000 and 100000')
    fireEvent.change(combo('Terminal scrollback'), { target: { value: '20000' } })
    fireEvent.keyDown(combo('Terminal scrollback'), { key: 'Enter' })
    expect(onChange).toHaveBeenLastCalledWith({ scrollbackLines: 20000 })
    fireEvent.change(combo('Word separators'), { target: { value: '()' } })
    fireEvent.blur(combo('Word separators'))
    expect(onChange).toHaveBeenLastCalledWith({ terminalWordSeparator: ' ()' })
    expect(optionsOf('Default shell')).toEqual(['System default shell', '/bin/zsh', '/bin/bash', '/bin/sh'])
    expect(select('Server replay buffer').value).toBe(String(DEFAULT_SETTINGS.scrollbackBytes))
  })

  it('Canvas section: grid size and new node size are selects of presets', () => {
    const onChange = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')))
    render(<CanvasSection settings={DEFAULT_SETTINGS} onChange={onChange} />)
    for (const name of ['Grid size', 'New node width', 'New node height']) expect(select(name).tagName).toBe('SELECT')
    fireEvent.change(select('New node width'), { target: { value: '800' } })
    expect(onChange).toHaveBeenCalledWith({ defaultNodeWidth: 800 })
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
    render(<AgentSettings settings={{ ...DEFAULT_SETTINGS, customAgents: [{ id: 'custom:x', label: 'X', launchCmd: '' }] }} onChange={onChange} />)
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

  it('Cost panel: the daily cap is a combobox with No limit and dollar presets', async () => {
    const data = { today: { costMicros: 0, cacheHitRate: null, unpriced: 0, byWorkspace: [], byNode: [], byRoutine: [], byModel: [] },
      week: { costMicros: 0, cacheHitRate: null, unpriced: 0, byWorkspace: [], byNode: [], byRoutine: [], byModel: [] },
      caps: [{ scope: 'day', spentMicros: 0, limitMicros: 10_000_000, pausedAt: null, reason: null }], labels: {}, pricing: { source: 'x', checkedAt: 'y' } }
    const f = vi.fn(async (url: string, _init?: RequestInit) => new Response(JSON.stringify(url === COST_API_PATH ? data : { ok: true })))
    vi.stubGlobal('fetch', f)
    render(<CostPanel />)
    await waitFor(() => expect(combo("Pause all work when today's spend reaches").value).toBe('10'))
    expect(optionsOf("Pause all work when today's spend reaches")).toEqual(['No limit', '$55', '$1010', '$2525', '$5050'])
    fireEvent.click(screen.getByRole('option', { name: /No limit/ }))
    await waitFor(() => expect(f.mock.calls.some(([u, i]) => u === `${COST_API_PATH}/caps` && String((i as RequestInit | undefined)?.body).includes('"limitMicros":0'))).toBe(true))
  })

  it('Policy simulator: subject is a select of principals; capability and scope offer known patterns', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ central: false, permissions: false }))))
    render(<PolicySimulator />)
    expect([...select('Who').options].map((o) => o.value)).toEqual(['node:*', 'central', 'routine:*', 'telegram:*', '*'])
    expect(optionsOf('What')).toContain('Click and type in web pagesbrowser.act')
    expect(optionsOf('Where')[0]).toBe('Anywhere*')
  })
})
