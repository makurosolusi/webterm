// Section "Fitur & server" di Settings: header + filter cepat, banner, kartu server, akordeon per
// section, bar simpan massal. State dari EnvSettingsProvider (dipasang ENV-05 di panel; bila tak ada,
// section memasang provider sendiri). Query pencarian tidak pernah membuang section/draft.
import { useCallback, useMemo, useRef, useState } from 'react'
import type { EnvEntryV2 } from '../shared/envSettings.contract'
import { Button } from '@/components/ui/button'
import { EnvGroupSection } from './EnvGroupSection'
import { EnvRestartBanner } from './EnvRestartBanner'
import { EnvSaveBar } from './EnvSaveBar'
import { EnvServerCard } from './EnvServerCard'
import { SettingsMessage } from './SettingsMessage'
import { normalizeQuery, useSettingsSearch } from './SettingsFields'
import {
  CHANNELS_OWNS_TELEGRAM, entryMatches, matchesQuickFilter, partitionEntries, type EnvQuickFilter, type EnvSectionData,
} from './envDraft'
import { ENV_UI } from './envSectionLabels'
import {
  EnvSettingsProvider, useEnvLoadOnMount, useEnvSettingsContext, useHasEnvSettingsContext,
} from './useEnvSettings'
import './settings-env.css'

interface Props {
  channelsOwned?: boolean
  /** Pindah ke tab Channels lalu fokus kunci itu (kunci milik Channels tak punya baris di sini). */
  onOpenChannels?: (key: string) => void
}

const FILTERS: Array<[EnvQuickFilter, string]> = [
  ['changed', ENV_UI.filterChanged], ['restart', ENV_UI.filterRestart], ['dangerous', ENV_UI.filterDangerous],
]
const FOCUSABLE = 'input,select,textarea,button,[role="switch"]'

/** Section Environment; memakai provider dari atas bila ada. */
export function EnvSection({ channelsOwned = CHANNELS_OWNS_TELEGRAM, onOpenChannels }: Props): React.JSX.Element {
  const query = useSettingsSearch()
  const hasProvider = useHasEnvSettingsContext()
  const panel = <EnvPanel channelsOwned={channelsOwned} onOpenChannels={onOpenChannels} />
  return hasProvider ? panel : <EnvSettingsProvider query={query}>{panel}</EnvSettingsProvider>
}

function EnvPanel({ channelsOwned, onOpenChannels }: Pick<Props, 'onOpenChannels'> & Required<Pick<Props, 'channelsOwned'>>): React.JSX.Element {
  const api = useEnvSettingsContext()
  useEnvLoadOnMount()
  const [filter, setFilter] = useState<EnvQuickFilter>()
  const root = useRef<HTMLDivElement>(null)
  const q = useMemo(() => normalizeQuery(api.query), [api.query])
  const state = api.state
  const part = useMemo(
    () => (state ? partitionEntries(state.entries, state.groups, channelsOwned) : null),
    [state, channelsOwned],
  )
  const visible = useCallback(
    (e: EnvEntryV2) => matchesQuickFilter(e, filter, api.draft) && entryMatches(e, q),
    [filter, q, api.draft],
  )
  const narrowed = q !== '' || filter !== undefined
  const onJump = useCallback((key: string): void => {
    const el = [...(root.current?.querySelectorAll<HTMLElement>('[data-env-item]') ?? [])].find((n) => n.dataset.envItem === key)
    if (!el) {
      if (state?.entries.some((e) => e.key === key && e.owner === 'channels')) onOpenChannels?.(key)
      return
    }
    for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) d.open = true
    el.scrollIntoView?.({ block: 'center' })
    el.querySelector<HTMLElement>(FOCUSABLE)?.focus()
  }, [state, onOpenChannels])
  const none = narrowed && part !== null && ![...part.main, ...part.advanced].some((s) => s.entries.some(visible))
  const group = (title: string, sections: EnvSectionData[], defaultOpen: boolean, sub = false): React.JSX.Element => (
    <EnvGroupSection key={title} title={title} sections={sections} defaultOpen={defaultOpen} subheadings={sub}
      visible={visible} narrowed={narrowed} onJump={onJump} />
  )
  return (
    <div className="st-env" aria-busy={api.loading} ref={root}>
      <div className="st-env-head">
        <h3 className="st-env-title">{ENV_UI.title}</h3>
        <div className="st-env-filters" role="group" aria-label={ENV_UI.filterGroup}>
          {FILTERS.map(([id, label]) => (
            <button key={id} type="button" className="st-button st-env-chip" aria-pressed={filter === id}
              onClick={() => setFilter(filter === id ? undefined : id)}>{label}</button>
          ))}
        </div>
        <button type="button" className="st-button" disabled={api.loading} onClick={() => void api.refresh()}>
          {ENV_UI.refresh}
        </button>
      </div>
      {api.loading ? <p className="st-note" role="status">{ENV_UI.loading}</p> : null}
      {api.error ? <SettingsMessage kind="error" role="alert">{api.error}</SettingsMessage> : null}
      {state?.locked ? <SettingsMessage kind="warning" role="status">{ENV_UI.lockedBanner}</SettingsMessage> : null}
      <EnvRestartBanner />
      {state && part ? (
        <>
          <div hidden={narrowed}><EnvServerCard server={state.server} rootGate={state.rootGate} /></div>
          {part.main.map((s) => group(s.title, [s], true))}
          {part.advanced.length > 0 ? group(ENV_UI.advanced, part.advanced, false, true) : null}
          {part.channels[0] ? (
            <SettingsMessage kind="info">
              <Button type="button" variant="link" size="sm" onClick={() => onOpenChannels?.(part.channels[0]!.key)}>
                {ENV_UI.channelsMoved}
              </Button>
            </SettingsMessage>
          ) : null}
          {none ? <p className="st-note">{ENV_UI.noMatch}</p> : null}
        </>
      ) : null}
      <EnvSaveBar />
    </div>
  )
}
