/**
 * @vitest-environment jsdom
 */
// Kontrol nilai env: flag case-insensitive, enum tak sah ditandai, hint Channels menyebut nama var benar.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EnvValueControl, localError } from './EnvValueControl'
import { CH } from './channelsLabels'
import type { EnvEntry } from './envSettingsApi'

const mk = (e: Partial<EnvEntry> & Pick<EnvEntry, 'key' | 'kind'>): EnvEntry => ({
  group: 'g', label: 'Lbl', description: 'd', source: 'default', value: '',
  restartRequired: false, pendingRestart: false, dangerous: false, editable: true,
  owner: 'o', section: 's', audience: 'advanced', requires: [], restart: 'none', effective: '', valid: true, ...e,
})
const flag = mk({ key: 'F', kind: 'flag' })
const enm = mk({ key: 'E', kind: 'enum', options: ['off', 'shadow', 'on'] })
const draw = (entry: EnvEntry, value: string, onChange = vi.fn()) => {
  render(<EnvValueControl entry={entry} value={value} disabled={false} onChange={onChange} />)
  return onChange
}

afterEach(cleanup)

describe('EnvValueControl', () => {
  it('flag: switch ON aktif, Off tidak, menulis on/off kanonik', () => {
    const onChange = draw(flag, 'ON')
    const box = screen.getByRole('switch') as HTMLInputElement
    expect(box.checked).toBe(true)
    expect(box.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(box)
    expect(onChange).toHaveBeenCalledWith('off')
    cleanup()
    draw(flag, 'Off')
    expect((screen.getByRole('switch') as HTMLInputElement).checked).toBe(false)
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

  it('enum on/off tampil sebagai switch; enum lain memakai optionLabels', () => {
    const onChange = draw(mk({ key: 'O', kind: 'enum', options: ['off', 'on'] }), 'on')
    fireEvent.click(screen.getByRole('switch'))
    expect(onChange).toHaveBeenCalledWith('off')
    cleanup()
    draw(mk({ key: 'M', kind: 'enum', options: ['', 'poll'], optionLabels: { '': 'Otomatis', poll: 'Polling' } }), '')
    expect(Array.from((screen.getByRole('combobox') as HTMLSelectElement).options).map((o) => o.text)).toEqual(['Otomatis', 'Polling'])
  })

  it('number: rentang + satuan terlihat; localError menolak non-angka dan di luar rentang', () => {
    const num = mk({ key: 'N', kind: 'number', min: 1, max: 60, unit: 'detik', default: '5' })
    draw(num, '5')
    expect(screen.getByText('1–60 detik')).toBeTruthy()
    expect((screen.getByRole('textbox') as HTMLInputElement).inputMode).toBe('decimal')
    expect(localError(num, 'abc')).toBe('Harus berupa angka.')
    expect(localError(num, '61')).toBe('Di luar rentang 1–60 detik.')
    expect(localError(num, '')).toBe('Isi angka.')
    expect(localError(num, '30')).toBeUndefined()
    expect(localError({ ...num, allowEmpty: true }, '')).toBeUndefined()
  })

  it('string absolutePath: relatif ditolak, absolut lolos; placeholder dari unsetLabel', () => {
    const p = mk({ key: 'P', kind: 'string', absolutePath: true, unsetLabel: '<dataDir>/memory' })
    expect(localError(p, 'rel/x')).toBe('Harus path absolut.')
    expect(localError(p, '/abs/x')).toBeUndefined()
    draw(p, '')
    expect((screen.getByRole('textbox') as HTMLInputElement).placeholder).toBe('<dataDir>/memory')
  })

  it('hint Channels menunjuk bagian konfigurasi di tab sendiri, bukan Environment', () => {
    expect(CH.inactiveHint).toContain('Nyalakan Telegram dan isi Token bot di bagian ini')
    expect(CH.inactiveHint).not.toContain('Fitur & server')
  })
})
