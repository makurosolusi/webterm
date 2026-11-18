/** @vitest-environment jsdom */
// Settings › Skill cable color / size: the pickers, the preview, search, and what SkillEdge draws from them.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ReactFlowProvider, type EdgeProps } from '@xyflow/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/settings'
import SkillEdge from './SkillEdge'
import { CanvasSection } from './SettingsCanvasSections'
import { SettingsItemScopeProvider } from './settingsContext'
import { searchSettings } from './settings.search'
import { setSkillStatus } from './skillNode.status'
import { skillCableVars } from './skillCable.style'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); setSkillStatus('sk', undefined) })

const group = (name: string) => screen.getByRole('radiogroup', { name })
const preview = () => screen.getAllByRole('img', { name: 'Skill cable preview' })[0].querySelector('line') as SVGLineElement
const fieldsFor = (q: string): (string | undefined)[] => searchSettings(q).flatMap((g) => g.entries.map((x) => x.field))

describe('skill cable pickers', () => {
  const mount = (settings = DEFAULT_SETTINGS) => {
    const onChange = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')))
    render(<SettingsItemScopeProvider settings={settings} onChange={onChange}><CanvasSection settings={settings} onChange={onChange} /></SettingsItemScopeProvider>)
    return onChange
  }

  it('color: named radios (Default first, then 12 hues), default checked, a click picks, no free hex field', () => {
    const onChange = mount()
    const radios = within(group('Skill cable color')).getAllByRole('radio')
    expect(radios.map((r) => r.textContent)).toEqual(['Default (accent)', 'Red', 'Orange', 'Amber', 'Lime', 'Green', 'Teal', 'Cyan', 'Blue', 'Indigo', 'Violet', 'Pink', 'Slate'])
    expect(radios[0].getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(group('Skill cable color')).getByRole('radio', { name: 'Teal' }))
    expect(onChange).toHaveBeenLastCalledWith({ skillCableColor: 'teal' })
  })

  it('arrow keys move focus without changing the setting; Space commits', () => {
    const onChange = mount()
    const radios = within(group('Skill cable color')).getAllByRole('radio')
    radios[0].focus()
    fireEvent.keyDown(radios[0], { key: 'ArrowRight' })
    expect(document.activeElement).toBe(radios[1])
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.keyDown(radios[1], { key: ' ' })
    expect(onChange).toHaveBeenLastCalledWith({ skillCableColor: 'red' })
  })

  it('size: four named widths, normal checked by default, a click picks', () => {
    const onChange = mount()
    const radios = within(group('Skill cable size')).getAllByRole('radio')
    expect(radios.map((r) => r.textContent)).toEqual(['Thin 1px', 'Normal 1.5px', 'Thick 3px', 'Extra thick 4px'])
    expect(radios[1].getAttribute('aria-checked')).toBe('true')
    fireEvent.click(radios[3])
    expect(onChange).toHaveBeenLastCalledWith({ skillCableSize: 'xthick' })
  })

  it('preview draws the chosen color and width', () => {
    mount()
    expect(preview().getAttribute('stroke')).toBe('var(--accent)')
    expect(preview().getAttribute('stroke-width')).toBe('1.5')
    cleanup()
    mount({ ...DEFAULT_SETTINGS, skillCableColor: 'violet', skillCableSize: 'thin' })
    expect(preview().getAttribute('stroke')).toBe('var(--ws-violet-default)')
    expect(preview().getAttribute('stroke-width')).toBe('1')
  })

  it('Reset appears once modified and restores the default', () => {
    const onChange = mount({ ...DEFAULT_SETTINGS, skillCableColor: 'blue' })
    fireEvent.click(screen.getByRole('button', { name: 'Reset Setting: Skill cable color' }))
    expect(onChange).toHaveBeenLastCalledWith({ skillCableColor: 'default' })
    expect(screen.queryByRole('button', { name: 'Reset Setting: Skill cable size' })).toBeNull()
  })

  it('search finds the rows by their words', () => {
    expect(fieldsFor('skill cable')).toEqual(expect.arrayContaining(['skillCableColor', 'skillCableSize']))
    expect(fieldsFor('cable color')).toContain('skillCableColor')
    expect(fieldsFor('cable width')).toContain('skillCableSize')
  })
})

describe('skillCableVars', () => {
  it('writes nothing for the defaults (no visual change for untouched installs)', () => {
    expect(skillCableVars(DEFAULT_SETTINGS)).toBeUndefined()
  })
  it('writes the palette token and px width for non-default choices', () => {
    expect(skillCableVars({ skillCableColor: 'pink', skillCableSize: 'thick' })).toEqual({ '--skill-edge-color': 'var(--ws-pink-default)', '--skill-edge-width': '3px' })
  })
})

describe('SkillEdge reads the choice', () => {
  const renderEdge = (extra: Record<string, unknown> = {}) => {
    render(
      <ReactFlowProvider>
        <svg><SkillEdge {...({ id: 'e1', source: 'sk', target: 'ag', sourceX: 0, sourceY: 0, targetX: 100, targetY: 100, sourcePosition: 'top', targetPosition: 'bottom', interactionWidth: 24, ...extra } as unknown as EdgeProps)} /></svg>
      </ReactFlowProvider>,
    )
    return document.querySelector('.skill-edge-path') as SVGPathElement
  }

  it('draws accent color through the variables, with a 1.5px fallback width', () => {
    const p = renderEdge()
    expect(p.style.stroke).toBe('var(--skill-edge-color, var(--accent))')
    expect(p.style.strokeWidth).toBe('var(--skill-edge-width, 1.5px)')
  })

  it('selected is relatively thicker than the chosen width', () => {
    expect(renderEdge({ selected: true }).style.strokeWidth).toBe('calc(var(--skill-edge-width, 1.5px) + 1.5px)')
  })

  it('an unavailable skill keeps the warning class and gets no color override', () => {
    setSkillStatus('sk', 'unavailable')
    const p = renderEdge()
    expect(p.classList.contains('skill-edge-path--warn')).toBe(true)
    expect(p.style.stroke).toBe('')
  })

  it('the hit area stays at least 12px (and keeps a wider one)', () => {
    const hit = (w: number) => { cleanup(); renderEdge({ interactionWidth: w }); return document.querySelector('.react-flow__edge-interaction')?.getAttribute('stroke-width') }
    expect(hit(1)).toBe('12')
    expect(hit(24)).toBe('24')
  })
})
