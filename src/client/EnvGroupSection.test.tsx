/**
 * @vitest-environment jsdom
 */
// Akordeon section: buka/tutup otomatis, baris disembunyikan (bukan di-unmount), props baris sesuai kontrak c-0.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EnvGroupSection } from './EnvGroupSection'
import { partitionEntries, type EnvSectionData } from './envDraft'
import { baseState, EnvHarness, putBodies, stubEnvApi } from './envTestFixtures'
import { useEnvSettingsContext } from './useEnvSettings'

vi.mock('./EnvEntryRow', async () => (await import('./envTestFixtures')).mockRowModule())
vi.setConfig({ testTimeout: 30_000 })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function secs(which: 'main' | 'advanced', mutate?: (s: ReturnType<typeof baseState>) => void): EnvSectionData[] {
  const s = baseState()
  mutate?.(s)
  return partitionEntries(s.entries, s.groups, false)[which]
}

function View(p: { sections: EnvSectionData[]; defaultOpen: boolean; narrowed?: boolean; hide?: string[]; sub?: boolean; onJump?: (k: string) => void }) {
  const api = useEnvSettingsContext()
  if (!api.state) return <p>loading</p>
  return <EnvGroupSection title="Judul" sections={p.sections} defaultOpen={p.defaultOpen} subheadings={p.sub} narrowed={p.narrowed ?? false}
    visible={(e) => !(p.hide ?? []).includes(e.key)} onJump={p.onJump ?? (() => undefined)} />
}
const mount = (v: Parameters<typeof View>[0]) => {
  const stub = stubEnvApi(baseState())
  render(<EnvHarness><View {...v} /></EnvHarness>)
  return stub
}
const details = (): HTMLDetailsElement => document.querySelector('details') as HTMLDetailsElement

describe('EnvGroupSection', () => {
  it('opens by default for user sections and stays closed for advanced', async () => {
    mount({ sections: secs('main'), defaultOpen: true })
    await screen.findByTestId('row-K_ONE')
    expect(details().open).toBe(true)
    cleanup()
    mount({ sections: secs('advanced'), defaultOpen: false, sub: true })
    await screen.findByTestId('row-K_ADV')
    expect(details().open).toBe(false)
    expect(screen.getByRole('heading', { name: 'Sec B' })).toBeTruthy()
  })

  it('auto-opens a closed section when an entry is invalid', async () => {
    const st = baseState()
    st.entries = st.entries.map((e) => (e.key === 'K_ADV' ? { ...e, valid: false } : e))
    stubEnvApi(st)
    const sections = partitionEntries(st.entries, st.groups, false).advanced
    render(<EnvHarness><View sections={sections} defaultOpen={false} /></EnvHarness>)
    await screen.findByTestId('row-K_ADV')
    expect(details().open).toBe(true)
  })

  it('auto-opens when the search/filter matches', async () => {
    mount({ sections: secs('advanced'), defaultOpen: false })
    await screen.findByTestId('row-K_ADV')
    expect(details().open).toBe(false)
    cleanup()
    mount({ sections: secs('advanced'), defaultOpen: false, narrowed: true })
    await screen.findByTestId('row-K_ADV')
    expect(details().open).toBe(true)
  })

  it('opens after a draft is written on an entry of a closed section', async () => {
    mount({ sections: secs('advanced'), defaultOpen: false })
    fireEvent.click(await screen.findByText('draft K_ADV'))
    await waitFor(() => expect(details().open).toBe(true))
    expect(screen.getByTestId('row-K_ADV').dataset.draft).toBe('changed')
  })

  it('hides non-matching rows with `hidden` but keeps them mounted; hides the whole group when none match', async () => {
    mount({ sections: secs('main'), defaultOpen: true, narrowed: true, hide: ['K_TWO'] })
    await screen.findByTestId('row-K_TWO')
    expect(screen.getByTestId('row-K_TWO').closest('[data-env-item]')?.hasAttribute('hidden')).toBe(true)
    expect(screen.getByTestId('row-K_ONE').closest('[data-env-item]')?.hasAttribute('hidden')).toBe(false)
    expect(details().hasAttribute('hidden')).toBe(false)
    cleanup()
    mount({ sections: secs('main'), defaultOpen: true, narrowed: true, hide: ['K_ONE', 'K_TWO', 'K_DANGER', 'K_SECRET'] })
    await screen.findByTestId('row-K_ONE')
    expect(details().hasAttribute('hidden')).toBe(true)
  })

  it('passes the c-0 props to rows and wires onDraft/onReset/onJump/get', async () => {
    const onJump = vi.fn()
    const stub = mount({ sections: secs('main'), defaultOpen: true, onJump })
    const row = await screen.findByTestId('row-K_ONE')
    expect(row.dataset.locked).toBe('false')
    expect(row.dataset.rootgate).toBe('true')
    expect(row.dataset.getOne).toBe('off')
    fireEvent.click(screen.getByText('draft K_ONE'))
    await waitFor(() => expect(screen.getByTestId('row-K_ONE').dataset.draft).toBe('on'))
    expect(screen.getByTestId('row-K_ONE').dataset.getOne).toBe('on')
    fireEvent.click(screen.getByText('jump K_ONE'))
    expect(onJump).toHaveBeenCalledWith('K_ADV')
    fireEvent.click(screen.getByText('reset K_TWO'))
    await waitFor(() => expect(putBodies(stub)).toEqual([{ unset: ['K_TWO'] }]))
    expect(screen.getByTestId('row-K_ONE').dataset.draft).toBe('on')
  })

  it('shows the visible-entry count in the summary', async () => {
    mount({ sections: secs('main'), defaultOpen: true, hide: ['K_TWO'] })
    await screen.findByTestId('row-K_ONE')
    expect(document.querySelector('.st-env-count')?.textContent).toBe('3')
  })
})
