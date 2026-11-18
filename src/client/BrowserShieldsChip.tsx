// Chip Shields di toolbar node browser (meniru ikon singa Brave): jumlah iklan/pelacak + popup yang diblokir di
// halaman ini, klik = matikan/nyalakan pemblokiran untuk situs ini (dipersist server per host, lalu muat ulang).
import { IconButton } from '@/components/ui/icon-button'
import type { BrowserState } from '../shared/browser.contract'
import { hostOnly } from '../shared/browser.url'
import { SHIELDS_TEXT } from './browser.uxText'

/** Tampil hanya bila server menjalankan Shields (`state.shieldsOff` terdefinisi). */
export default function BrowserShieldsChip({ state, onToggle }: { state?: BrowserState; onToggle: (on: boolean) => void }) {
  if (state?.shieldsOff === undefined) return null
  const off = state.shieldsOff
  const host = hostOnly(state.url)
  const ads = state.blockedAds ?? 0
  const popups = state.blockedPopups ?? 0
  const total = ads + popups
  return (
    <IconButton
      type="button" size="bui" label={SHIELDS_TEXT.label} aria-pressed={!off}
      tooltip={off ? SHIELDS_TEXT.off(host) : SHIELDS_TEXT.on(ads, popups, host)}
      className={off ? 'opacity-60' : undefined}
      onClick={() => onToggle(off)}
    >
      <span className={`codicon codicon-${off ? 'circle-slash' : 'shield'}`} aria-hidden="true" />
      {!off && total > 0 && <span className="tabular-nums">{total}</span>}
    </IconButton>
  )
}
