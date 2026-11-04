// Tab Kemampuan (ENVSIMPLE D6): tujuh kartu urut katalog, satu sakelar tiap kartu, plus "Lanjutan".
// Kartu Telegram diganti alur tempel-token. Pencarian: judul bagian, atau judul + blurb + kata kunci kartu
// (pola indeks pencarian Orca `settings/search/settings-search.ts`: title + description + keywords).
import { useEffect, useState } from 'react'
import { CAPABILITIES } from '../shared/featureCapabilities'
import type { CapabilityId, CapabilityView } from '../shared/featureCapabilities'
import { AdvancedSection } from './AdvancedSection'
import { ADVANCED_TEXT, SECTION_TEXT } from './advancedLabels'
import { CAPABILITY_KEYWORDS } from './capabilitiesLabels'
import { CapabilityCard } from './CapabilityCard'
import { matchesSearch } from './SettingsFields'
import { TelegramCard } from './TelegramCard'
import { TokenAccessCard } from './TokenAccessCard'
import { TOKEN_TEXT } from './tokenAccessLabels'
import { useCapabilities } from './useCapabilities'
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
  const show = (key: CapabilityId | 'advanced' | 'token'): boolean => {
    if (query === '' || matchesSearch(sectionTitle, query)) return true
    const text = key === 'advanced' ? ADVANCED_TEXT.summary : key === 'token' ? `${TOKEN_TEXT.title} ${TOKEN_TEXT.why}` : `${CAPABILITIES[key].title} ${CAPABILITIES[key].blurb}`
    return matchesSearch(`${text} ${CAPABILITY_KEYWORDS[key].join(' ')}`, query)
  }
  const visible = all.filter((v) => show(v.id)).length + (api.data && show('advanced') ? 1 : 0) + (show('token') ? 1 : 0)
  useEffect(() => {
    onVisibleCount?.(visible)
    return () => onVisibleCount?.(0)
  }, [visible, onVisibleCount])

  // fixChain = nyalakan kartu ini lewat toggle biasa: server ikut menyalakan prasyaratnya
  // (`closure`), pilihan kartu lain tidak disentuh. Dulu memanggil /reset yang menghapus semuanya.
  // `kind` dilebarkan ke string: 'agentEngine' (central butuh Claude Code/OpenCode) bisa datang dari server
  // sebelum tipe bersama memuatnya. Mesin agen dipilih di Lanjutan, sama seperti lokasi Chrome.
  const onStep = (id: CapabilityId, kind: NonNullable<CapabilityView['step']>['kind'] | (string & {})): void => {
    if (kind === 'chromiumPath' || kind === 'agentEngine') setAdvancedOpen(true)
    else if (kind === 'telegramToken') document.getElementById(TELEGRAM_TOKEN_INPUT_ID)?.focus()
    else void api.toggle(id, true)
  }

  return (
    <div className="st-capabilities">
      {api.error ? <p role="alert" className="text-xs text-destructive">{api.error}</p> : null}
      {api.data === null && api.error === null ? <p role="status" className="text-xs opacity-70">{SECTION_TEXT.loading}</p> : null}
      {all.map((view) => {
        if (!show(view.id)) return null
        return view.id === 'telegram' ? (
          <div key={view.id} data-capability="telegram"><TelegramCard projectId={projectId} /></div>
        ) : (
          <CapabilityCard key={view.id} view={view} all={all} busy={api.busyId === view.id}
            onToggle={(on) => void api.toggle(view.id, on)}
            onSub={(key, on) => void api.setSub(view.id, key, on)}
            onStep={(kind) => onStep(view.id, kind)} />
        )
      })}
      {show('token') ? <TokenAccessCard /> : null}
      {api.data && show('advanced') ? (
        <AdvancedSection advanced={api.data.advanced} onChanged={api.refresh} onRecheck={api.recheck} open={advancedOpen} onOpenChange={setAdvancedOpen} />
      ) : null}
    </div>
  )
}
