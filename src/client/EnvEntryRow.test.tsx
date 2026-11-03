/**
 * @vitest-environment jsdom
 */
// Baris env v2: label/kontrol, switch, badge hanya bila perlu, Default+Reset, requires, error a11y, secret, terkunci.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EnvEntryRow, type EnvEntryRowProps } from './EnvEntryRow'
import type { EnvEntry } from './envSettingsApi'

const mk = (e: Partial<EnvEntry> & Pick<EnvEntry, 'key' | 'kind'>): EnvEntry => ({
  group: 'g', label: `Label ${e.key}`, description: `Desc ${e.key}`, source: 'default', value: '',
  restartRequired: false, pendingRestart: false, dangerous: false, editable: true,
  owner: 'o', section: 's', audience: 'user', requires: [], restart: 'none', effective: '', valid: true, ...e,
})
const flag = (o: Partial<EnvEntry> = {}): EnvEntry => mk({ key: 'F', kind: 'flag', value: 'off', default: 'off', effective: 'off', ...o })

function draw(entry: EnvEntry, p: Partial<EnvEntryRowProps> = {}) {
  const fns = { onDraft: vi.fn(), onReset: vi.fn(), onJump: vi.fn() }
  const props: EnvEntryRowProps = { entry, get: () => undefined, locked: false, rootGate: true, ...fns, ...p }
  const view = render(<ul><EnvEntryRow {...props} /></ul>)
  return { ...fns, rerender: (n: Partial<EnvEntryRowProps>) => view.rerender(<ul><EnvEntryRow {...props} {...n} /></ul>) }
}
const row = (): HTMLElement => screen.getByRole('listitem')
afterEach(cleanup)

describe('EnvEntryRow', () => {
  it('label terhubung ke kontrol; tidak ada tombol Simpan; tanpa badge/Reset pada nilai default', () => {
    draw(flag())
    expect(screen.getByLabelText('Label F')).toBe(screen.getByRole('switch'))
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByText(/Diubah|Perlu restart|Dari \.env|Dikunci|^default$/)).toBeNull()
    expect(row().getAttribute('data-env-key')).toBe('F')
  })

  it('flag: switch aria-checked mengikuti draft dan menulis on/off', () => {
    const { onDraft } = draw(flag(), { draft: 'ON' })
    const sw = screen.getByRole('switch') as HTMLInputElement
    expect(sw.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(sw)
    expect(onDraft).toHaveBeenCalledWith('off')
  })

  it('badge Diubah + "Default: ..." + Reset hanya saat nilai beda default; Reset override memanggil onReset dan memfokuskan kontrol', () => {
    const { onReset } = draw(flag({ value: 'on', source: 'override' }))
    expect(within(row()).getByText('Diubah')).toBeTruthy()
    expect(within(row()).getByText('Default: off')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reset F' }))
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(screen.getByRole('switch'))
  })

  it('override bernilai sama dengan default: tanpa badge Diubah dan tanpa teks Default', () => {
    draw(flag({ source: 'override' }))
    expect(screen.queryByText('Diubah')).toBeNull()
    expect(screen.queryByText(/^Default:/)).toBeNull()
  })

  it('Reset pada draft murni mengembalikan draft ke nilai tersimpan tanpa menyentuh server', () => {
    const { onReset, onDraft } = draw(flag(), { draft: 'on' })
    fireEvent.click(screen.getByRole('button', { name: 'Reset F' }))
    expect(onDraft).toHaveBeenCalledWith('off')
    expect(onReset).not.toHaveBeenCalled()
  })

  it('Default memakai effectiveDefault bila ada', () => {
    draw(mk({ key: 'M', kind: 'enum', options: ['', 'poll'], value: 'poll', default: '', effectiveDefault: 'otomatis', source: 'override' }))
    expect(within(row()).getByText('Default: otomatis')).toBeTruthy()
  })

  it('Perlu restart + "Aktif sekarang/Tersimpan" untuk kunci boot yang efektifnya beda; hot tidak', () => {
    draw(mk({ key: 'B', kind: 'string', value: 'new', effective: 'old', restart: 'boot' }))
    expect(within(row()).getByText('Perlu restart')).toBeTruthy()
    expect(within(row()).getByText('Aktif sekarang: old · Tersimpan: new')).toBeTruthy()
    cleanup()
    draw(mk({ key: 'H', kind: 'string', value: 'new', effective: 'old', restart: 'hot' }))
    expect(screen.queryByText('Perlu restart')).toBeNull()
  })

  it('Dari .env, Dikunci, dan Berbahaya (dangerNote via aria-describedby)', () => {
    draw(flag({ source: 'env', editable: false, dangerous: true, dangerNote: 'Buka akses penuh' }))
    expect(within(row()).getByText('Dari .env')).toBeTruthy()
    expect(within(row()).getByText('Dikunci')).toBeTruthy()
    const danger = within(row()).getByText('Berbahaya').closest('.st-tag') as HTMLElement
    expect(document.getElementById(danger.getAttribute('aria-describedby')!)?.textContent).toBe('Buka akses penuh')
    expect((screen.getByRole('switch') as HTMLInputElement).disabled).toBe(true)
  })

  it('dangerous terkunci tanpa rootGate: baris read-only, tanpa pesan token per baris', () => {
    draw(mk({ key: 'D', kind: 'string', value: 'x', dangerous: true, editable: false }), { rootGate: false })
    expect((screen.getByRole('textbox') as HTMLInputElement).disabled).toBe(true)
    expect(screen.queryByText(/token root/i)).toBeNull()
  })

  it('requires: peringatan + Buka untuk yang belum terpenuhi; draft memenuhi; kunci tak dikenal diam', () => {
    const e = flag({ requires: [{ key: 'DEP' }, { key: 'MODE', oneOf: ['a', 'b'] }, { key: 'NOPE' }] })
    const vals: Record<string, string> = { DEP: 'off', MODE: 'a' }
    const { onJump, rerender } = draw(e, { get: (k) => vals[k] })
    expect(within(row()).getByText(/Belum berpengaruh: butuh/).textContent).toContain('DEP = on')
    expect(screen.queryByText(/MODE/)).toBeNull()
    expect(screen.queryByText(/NOPE/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Buka DEP' }))
    expect(onJump).toHaveBeenCalledWith('DEP')
    rerender({ get: (k) => ({ ...vals, DEP: 'on' })[k] })
    expect(screen.queryByText(/Belum berpengaruh/)).toBeNull()
  })

  it('error angka: aria-invalid + aria-describedby ke pesan Indonesia, hilang saat input valid', () => {
    const num = mk({ key: 'N', kind: 'number', value: '5', default: '5', min: 1, max: 60, unit: 'detik' })
    const { rerender } = draw(num, { draft: 'abc' })
    const input = screen.getByRole('textbox')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    const ids = input.getAttribute('aria-describedby')!.split(' ')
    expect(ids.map((i) => document.getElementById(i)?.textContent).join('|')).toContain('Harus berupa angka.')
    rerender({ draft: '30' })
    expect(screen.getByRole('textbox').getAttribute('aria-invalid')).toBeNull()
    expect(screen.queryByText('Harus berupa angka.')).toBeNull()
  })

  it('nilai tersimpan tak sah (valid:false): enum menampilkan rawValue sebagai opsi tidak sah + alasan server', () => {
    draw(mk({ key: 'E', kind: 'enum', options: ['off', 'shadow', 'on'], value: 'off', valid: false, rawValue: 'xyz', invalidReason: 'Nilai bukan opsi sah' }))
    const sel = screen.getByRole('combobox') as HTMLSelectElement
    expect(sel.getAttribute('aria-invalid')).toBe('true')
    expect(sel.options[0]!.text).toBe('— tidak sah: "xyz" —')
    expect(screen.getByText('Nilai bukan opsi sah')).toBeTruthy()
  })

  it('secret: status Terisi/Kosong, ketik -> onDraft, Hapus -> onReset + fokus ke input; tanpa tombol Simpan', () => {
    const SENTINEL = 'TOK-SENTINEL-123' // test-only
    const sec = mk({ key: 'S', kind: 'secret', source: 'override', set: true, secretSet: true })
    const { onDraft, onReset } = draw(sec)
    expect(within(row()).getByText('Terisi')).toBeTruthy()
    const input = screen.getByLabelText('Label S') as HTMLInputElement
    expect(input.type).toBe('password')
    expect(input.value).toBe('')
    fireEvent.change(input, { target: { value: SENTINEL } })
    expect(onDraft).toHaveBeenCalledWith(SENTINEL)
    fireEvent.click(screen.getByRole('button', { name: 'Hapus S' }))
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(input)
    expect(screen.queryByRole('button', { name: /Simpan/ })).toBeNull()
    expect(row().textContent).not.toContain(SENTINEL)
  })

  it('secret kosong: status Kosong dan tanpa tombol Hapus', () => {
    draw(mk({ key: 'S', kind: 'secret', set: false, secretSet: false }))
    expect(within(row()).getByText('Kosong')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Hapus S' })).toBeNull()
  })
})
