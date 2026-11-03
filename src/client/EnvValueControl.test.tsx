/**
 * @vitest-environment jsdom
 */
// Kontrol nilai env: flag case-insensitive, enum tak sah ditandai, hint Channels menyebut nama var benar.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EnvValueControl } from './EnvValueControl'
import { CH } from './channelsLabels'
import type { EnvEntry } from './envSettingsApi'

const mk = (e: Partial<EnvEntry> & Pick<EnvEntry, 'key' | 'kind'>): EnvEntry => ({
  group: 'g', label: 'Lbl', description: 'd', source: 'default',
  restartRequired: false, pendingRestart: false, dangerous: false, editable: true, ...e,
})
const flag = mk({ key: 'F', kind: 'flag' })
const enm = mk({ key: 'E', kind: 'enum', options: ['off', 'shadow', 'on'] })
const draw = (entry: EnvEntry, value: string, onChange = vi.fn()) => {
  render(<EnvValueControl entry={entry} value={value} disabled={false} onChange={onChange} />)
  return onChange
}

afterEach(cleanup)

describe('EnvValueControl', () => {
  it('flag: ON tercentang, Off tidak, menulis on/off kanonik', () => {
    const onChange = draw(flag, 'ON')
    const box = screen.getByRole('checkbox') as HTMLInputElement
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    expect(onChange).toHaveBeenCalledWith('off')
    cleanup()
    draw(flag, 'Off')
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  })

  it('enum: nilai sah beda huruf dipilih tanpa tanda tak sah', () => {
    draw(enm, 'SHADOW')
    const sel = screen.getByRole('combobox') as HTMLSelectElement
    expect(sel.value).toBe('shadow')
    expect(sel.getAttribute('aria-invalid')).toBeNull()
  })

  it('enum: nilai asing -> opsi tidak sah terpilih, aria-invalid, pilih sah mengubah draft', () => {
    const onChange = draw(enm, 'xyz')
    const sel = screen.getByRole('combobox') as HTMLSelectElement
    expect(sel.getAttribute('aria-invalid')).toBe('true')
    expect(sel.options[0]!.text).toBe('— tidak sah: "xyz" —')
    expect(sel.selectedIndex).toBe(0)
    expect(screen.getByText('Nilai tidak dikenal, dibaca sebagai bawaan')).toBeTruthy()
    fireEvent.change(sel, { target: { value: 'on' } })
    expect(onChange).toHaveBeenCalledWith('on')
  })

  it('enum: nilai asing panjang dipotong 40 karakter', () => {
    draw(enm, 'x'.repeat(60))
    expect((screen.getByRole('combobox') as HTMLSelectElement).options[0]!.text).toBe(`— tidak sah: "${'x'.repeat(40)}…" —`)
  })

  it('hint Channels menyebut nama var yang benar', () => {
    expect(CH.inactiveHint).toContain('WEBTERM_TELEGRAM=on')
    expect(CH.inactiveHint).toContain('WEBTERM_TELEGRAM_BOT_TOKEN')
    expect(CH.inactiveHint).toContain('Atur di Settings > Fitur & server (sementara) lalu restart')
    expect(CH.inactiveHint.replace('WEBTERM_TELEGRAM_BOT_TOKEN', '')).toContain('alias lama: TELEGRAM_BOT_TOKEN')
  })
})
