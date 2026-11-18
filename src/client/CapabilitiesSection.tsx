// Settings › Features (id `capabilities`): one card per feature, as in macOS System Settings. Browser (its
// switch + the search engine), Files (its switch; Edit and upload files is a sub-switch while on) and Telegram
// (connect a bot: the card is the setup). A failed change is shown on its row. The Central Agent switches live in
// Settings › Central; the Claude provider and token access in the Claude page. Advanced: Chromium location and Reset.
import { useState } from 'react'
import type { CapabilityId, CapabilityView } from '../shared/featureCapabilities'
import type { Settings } from '../shared/settings'
import { SEARCH_ENGINES, type SearchEngine } from '../shared/browser.omnibox'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { AdvancedSection } from './AdvancedSection'
import { SECTION_TEXT } from './advancedLabels'
import { CapabilityCard } from './CapabilityCard'
import { CardError, CardLoading } from './SettingsCardState'
import { SettingsGroup } from './SettingsControls'
import { SelectField } from './SettingsFields'
import { TelegramCard } from './TelegramCard'
import { useCapabilities } from './useCapabilities'
import './settings-capabilities.css'
import './settings-system.css'

const TELEGRAM_TOKEN_INPUT_ID = 'tg-token'
/** Cards of their own, in this order; `filesWrite` rides inside Files, Central's three are elsewhere. */
const CARD_IDS: readonly CapabilityId[] = ['browser', 'files', 'telegram']
/** Card headings: the feature's area, so the row inside can keep the feature's full title. */
const GROUP_TITLE: Partial<Record<CapabilityId, string>> = { browser: 'Browser', files: 'Files', telegram: 'Telegram' }

export interface CapabilitiesSectionProps {
  /** Project a linked Telegram chat goes to (the open workspace). */
  projectId: string
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
}

/** The Features page: loads from the server and waits for it on every change. */
export function CapabilitiesSection({ projectId, settings: s, onChange }: CapabilitiesSectionProps): React.JSX.Element {
  const api = useCapabilities()
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const all = api.data?.capabilities ?? []
  const byId = (id: CapabilityId): CapabilityView | undefined => all.find((v) => v.id === id)
  const errorFor = (...ids: CapabilityId[]): string | null => (api.errorId && ids.includes(api.errorId) ? api.error : null)

  // fixChain = turn this card on through the ordinary toggle: the server turns on what it needs (`closure`).
  const onStep = (id: CapabilityId, kind: NonNullable<CapabilityView['step']>['kind']): void => {
    if (kind === 'chromiumPath') setAdvancedOpen(true)
    else if (kind === 'telegramToken') document.getElementById(TELEGRAM_TOKEN_INPUT_ID)?.focus()
    else void api.toggle(id, true)
  }
  const card = (view: CapabilityView, children?: React.ReactNode): React.JSX.Element => (
    <CapabilityCard key={view.id} view={view} all={all} busy={api.busyId === view.id} error={errorFor(view.id, ...(view.id === 'files' ? ['filesWrite' as const] : []))}
      onToggle={(on) => void api.toggle(view.id, on)}
      onSub={(key, on) => void api.setSub(view.id, key, on)}
      onStep={(kind) => onStep(view.id, kind)}>
      {children}
    </CapabilityCard>
  )
  const write = byId('filesWrite')
  // Busy while it runs (busyId), and a refusal shows on the Files card (errorFor).
  const setWrite = (on: boolean): void => { void api.toggle('filesWrite', on) }
  const writeBusy = api.busyId === 'filesWrite'

  return (
    <div className="st-capabilities">
      {api.error && api.errorId === null ? <SettingsGroup><CardError text={api.error} onRetry={() => void api.refresh()} /></SettingsGroup> : null}
      {api.data === null && api.error === null ? <SettingsGroup><CardLoading text={SECTION_TEXT.loading} /></SettingsGroup> : null}
      {CARD_IDS.map((id) => {
        const view = byId(id)
        if (!view) return null
        if (id === 'telegram') {
          return (
            <SettingsGroup key={id} title={GROUP_TITLE[id]} description={view.blurb}>
              <div className="st-form" data-capability="telegram" data-field="capability.telegram"><TelegramCard projectId={projectId} /></div>
            </SettingsGroup>
          )
        }
        if (id === 'browser') {
          return (
            <SettingsGroup key={id} title={GROUP_TITLE[id]}>
              {card(view)}
              <SelectField setting="browserSearchEngine" id="st-browserSearchEngine" label="Search engine" value={s.browserSearchEngine}
                hint="Used when you type words instead of an address."
                options={(Object.keys(SEARCH_ENGINES) as SearchEngine[]).map((e) => ({ value: e, label: SEARCH_ENGINES[e].label }))}
                onChange={(v) => onChange({ browserSearchEngine: v })} />
            </SettingsGroup>
          )
        }
        return (
          <SettingsGroup key={id} title={GROUP_TITLE[id]}>
            {card(view, write ? (
              <div className="st-field st-field--sub" data-capability="filesWrite" data-field="capability.filesWrite">
                <div className="st-field-text">
                  <Label htmlFor="capability-sub-files-write" className="st-label">{write.title}</Label>
                  <p className="st-hint">{write.blurb}</p>
                </div>
                <div className="st-control">
                  <Switch id="capability-sub-files-write" checked={write.status !== 'off'} disabled={writeBusy} onCheckedChange={setWrite} />
                </div>
              </div>
            ) : null)}
          </SettingsGroup>
        )
      })}
      {api.data ? (
        <AdvancedSection advanced={api.data.advanced} onChanged={api.refresh} open={advancedOpen} onOpenChange={setAdvancedOpen} />
      ) : null}
    </div>
  )
}
