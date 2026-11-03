// Tab Kemampuan (ENVSIMPLE D6): tujuh kartu urut katalog, satu sakelar tiap kartu, plus "Lanjutan".
// Kartu Telegram diganti alur tempel-token; pencarian hanya mencocokkan judul bagian dan judul kartu.
import { useEffect, useState } from 'react'
import { CAPABILITIES } from '../shared/featureCapabilities'
import { AdvancedSection } from './AdvancedSection'
import { ADVANCED_TEXT, SECTION_TEXT } from './advancedLabels'
import { callCapabilities } from './capabilitiesApi'
import { CapabilityCard } from './CapabilityCard'
import { matchesSearch } from './SettingsFields'
import { TelegramCard } from './TelegramCard'
import { capabilityErrorMessage, useCapabilities } from './useCapabilities'
import './settings-capabilities.css'

const TELEGRAM_TOKEN_INPUT_ID = 'tg-token'

export interface CapabilitiesSectionProps {
  /** Proyek tujuan tautan chat Telegram (workspace aktif). */
  projectId: string
  /** Query pencarian ternormalisasi; kosong = tampil semua. */
  query: string
  /** Judul bagian; cocok dengan query = semua kartu tampil. */
  sectionTitle: string
  /** Melaporkan jumlah kartu/butir yang tampil (untuk hitungan hasil pencarian). */
  onVisibleCount?(count: number): void
}

/** Isi tab Kemampuan; memuat dari server dan menunggu server pada tiap perubahan. */
export function CapabilitiesSection({ projectId, query, sectionTitle, onVisibleCount }: CapabilitiesSectionProps): React.JSX.Element {
  const api = useCapabilities()
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const all = api.data?.capabilities ?? []
  const show = (title: string): boolean => query === '' || matchesSearch(sectionTitle, query) || matchesSearch(title, query)

  const [stepError, setStepError] = useState<string | null>(null)
  const fixChain = async (): Promise<void> => {
    try {
      await callCapabilities('/reset', 'POST', {})
      setStepError(null)
      await api.refresh()
    } catch (e) {
      setStepError(capabilityErrorMessage(e, ADVANCED_TEXT.changeFailed))
    }
  }
  const visible = all.filter((v) => show(CAPABILITIES[v.id].title)).length + (api.data && show(ADVANCED_TEXT.summary) ? 1 : 0)
  useEffect(() => {
    onVisibleCount?.(visible)
    return () => onVisibleCount?.(0)
  }, [visible, onVisibleCount])

  const onStep = (kind: 'fixChain' | 'telegramToken' | 'chromiumPath'): void => {
    if (kind === 'chromiumPath') setAdvancedOpen(true)
    else if (kind === 'telegramToken') document.getElementById(TELEGRAM_TOKEN_INPUT_ID)?.focus()
    else void fixChain()
  }

  return (
    <div className="st-capabilities">
      {api.error ?? stepError ? <p role="alert" className="text-xs text-destructive">{api.error ?? stepError}</p> : null}
      {api.data === null && api.error === null ? <p role="status" className="text-xs opacity-70">{SECTION_TEXT.loading}</p> : null}
      {all.map((view) => {
        if (!show(CAPABILITIES[view.id].title)) return null
        return view.id === 'telegram' ? (
          <div key={view.id} data-capability="telegram"><TelegramCard projectId={projectId} /></div>
        ) : (
          <CapabilityCard key={view.id} view={view} all={all} busy={api.busyId === view.id}
            onToggle={(on) => void api.toggle(view.id, on)}
            onSub={(key, on) => void api.setSub(view.id, key, on)}
            onStep={onStep} />
        )
      })}
      {api.data && show(ADVANCED_TEXT.summary) ? (
        <AdvancedSection advanced={api.data.advanced} onChanged={api.refresh} open={advancedOpen} onOpenChange={setAdvancedOpen} />
      ) : null}
    </div>
  )
}
