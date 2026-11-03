// Satu akordeon <details> per section env (atau "Lanjutan" berisi banyak section). Baris yang tak
// cocok filter/pencarian hanya disembunyikan (`hidden`), jadi state & draft tetap aman.
import { useState } from 'react'
import type { EnvEntryV2 } from '../shared/envSettings.contract'
import type { EnvSectionData } from './envDraft'
import { EnvRow } from './envRowContract'
import { useEnvSettingsContext } from './useEnvSettings'

interface Props {
  title: string
  sections: EnvSectionData[]
  /** Terbuka awal (audience user). */
  defaultOpen: boolean
  /** Beri sub-judul per section (untuk "Lanjutan"). */
  subheadings?: boolean
  visible: (e: EnvEntryV2) => boolean
  /** Pencarian/filter aktif: entri yang cocok membuka akordeon, grup tanpa cocok disembunyikan. */
  narrowed: boolean
  onJump: (key: string) => void
}

/** Akordeon section; terbuka otomatis bila ada entri tak sah, dirty, atau cocok pencarian. */
export function EnvGroupSection({ title, sections, defaultOpen, subheadings, visible, narrowed, onJump }: Props): React.JSX.Element {
  const api = useEnvSettingsContext()
  const [userOpen, setUserOpen] = useState(defaultOpen)
  const entries = sections.flatMap((s) => s.entries)
  const shown = entries.filter(visible)
  const forceOpen = entries.some((e) => !e.valid || api.draft.has(e.key)) || (narrowed && shown.length > 0)
  const open = userOpen || forceOpen
  const locked = api.state?.locked ?? false
  const rootGate = api.state?.rootGate ?? false
  const row = (e: EnvEntryV2): React.JSX.Element => (
    <div key={e.key} className="st-env-item" data-env-item={e.key} hidden={!visible(e)}>
      <EnvRow entry={e} draft={api.draft.get(e.key)} onDraft={(v) => api.setDraft(e.key, v)}
        onReset={() => void api.reset(e.key)} get={api.valueOf} onJump={onJump} locked={locked} rootGate={rootGate} />
    </div>
  )
  return (
    <details className="st-env-group" hidden={narrowed && shown.length === 0}
      open={open} onToggle={(ev) => { if (ev.currentTarget.open !== open) setUserOpen(ev.currentTarget.open) }}>
      <summary className="st-env-summary">
        {title} <span className="st-env-count">{shown.length}</span>
      </summary>
      {sections.map((s) => (
        <div key={s.title} className="st-env-sec" hidden={!s.entries.some(visible)}>
          {subheadings ? <h4 className="st-env-heading">{s.title}</h4> : null}
          {s.entries.map(row)}
        </div>
      ))}
    </details>
  )
}
