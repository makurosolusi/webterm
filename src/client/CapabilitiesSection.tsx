// Settings › Features (id `capabilities`): Browser (+ its search engine), Files (Edit and upload files is a
// sub-option of its card) and Telegram, each with ONE switch; a failed change is shown on its card. The
// Central Agent switches live in Settings › Central Agent; the Claude provider and token access in the
// Claude page. Advanced: Chromium location and Reset.
import { useState } from 'react'
import type { CapabilityId, CapabilityView } from '../shared/featureCapabilities'
import type { Settings } from '../shared/settings'
import { SEARCH_ENGINES, type SearchEngine } from '../shared/browser.omnibox'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { AdvancedSection } from './AdvancedSection'
import { SECTION_TEXT } from './advancedLabels'
import { CapabilityCard } from './CapabilityCard'
import { SelectField } from './SettingsFields'
import { TelegramCard } from './TelegramCard'
import { useCapabilities } from './useCapabilities'
import './settings-capabilities.css'

const TELEGRAM_TOKEN_INPUT_ID = 'tg-token'
/** Cards of their own, in this order; `filesWrite` rides inside Files, Central's three are elsewhere. */
const CARD_IDS: readonly CapabilityId[] = ['browser', 'files', 'telegram']

export interface CapabilitiesSectionProps {
  /** Proyek tujuan tautan chat Telegram (workspace aktif). */
  projectId: string
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
}

/** Isi halaman Features; memuat dari server dan menunggu server pada tiap perubahan. */
export function CapabilitiesSection({ projectId, settings: s, onChange }: CapabilitiesSectionProps): React.JSX.Element {
  const api = useCapabilities()
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const all = api.data?.capabilities ?? []
  const byId = (id: CapabilityId): CapabilityView | undefined => all.find((v) => v.id === id)
  const errorFor = (...ids: CapabilityId[]): string | null => (api.errorId && ids.includes(api.errorId) ? api.error : null)

  // fixChain = nyalakan kartu ini lewat toggle biasa: server ikut menyalakan prasyaratnya (`closure`).
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
      {api.error && api.errorId === null ? <p role="alert" className="text-xs text-destructive">{api.error}</p> : null}
      {api.data === null && api.error === null ? <p role="status" className="text-xs opacity-70">{SECTION_TEXT.loading}</p> : null}
      {CARD_IDS.map((id) => {
        const view = byId(id)
        if (!view) return null
        if (id === 'telegram') return <div key={id} data-capability="telegram" data-field="capability.telegram"><TelegramCard projectId={projectId} /></div>
        if (id === 'browser') {
          return (
            <div key={id}>
              {card(view)}
              <SelectField setting="browserSearchEngine" id="st-browserSearchEngine" label="Browser search engine" value={s.browserSearchEngine}
                hint="Used by browser nodes when what you type in the address bar is not a web address."
                options={(Object.keys(SEARCH_ENGINES) as SearchEngine[]).map((e) => ({ value: e, label: SEARCH_ENGINES[e].label }))}
                onChange={(v) => onChange({ browserSearchEngine: v })} />
            </div>
          )
        }
        return card(view, write ? (
          <div className="flex items-center gap-2" data-capability="filesWrite" data-field="capability.filesWrite">
            <Checkbox id="capability-sub-files-write" checked={write.status !== 'off'} disabled={writeBusy}
              onCheckedChange={(v) => setWrite(v === true)} />
            <Label htmlFor="capability-sub-files-write" className="text-xs">{write.title}</Label>
          </div>
        ) : null)
      })}
      {api.data ? (
        <AdvancedSection advanced={api.data.advanced} onChanged={api.refresh} open={advancedOpen} onOpenChange={setAdvancedOpen} />
      ) : null}
    </div>
  )
}
