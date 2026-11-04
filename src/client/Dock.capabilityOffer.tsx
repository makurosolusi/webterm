import { useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { CAPABILITIES } from '../shared/featureCapabilities'
import { CapabilityOffer } from './CapabilityOffer'
import { CAPABILITY_TEXT } from './capabilitiesLabels'
import { resetBrowserStatusCache } from './browser.feature'

type OfferId = 'browser' | 'central'

/**
 * Tawaran menyalakan kemampuan (sama dengan menu kanvas): browser untuk "Add > Browser", central
 * untuk item Central. Aksi aslinya jalan begitu handler-nya terbit (kemampuan sudah menyala).
 */
export function useCapabilityOffer(onAddBrowser?: () => void, onToggleCentral?: () => void) {
  const [offer, setOffer] = useState<OfferId | null>(null)
  const pending = useRef<OfferId | null>(null)
  useEffect(() => {
    if (pending.current !== 'browser' || !onAddBrowser) return
    pending.current = null
    onAddBrowser()
  }, [onAddBrowser])
  useEffect(() => {
    if (pending.current !== 'central' || !onToggleCentral) return
    pending.current = null
    onToggleCentral()
  }, [onToggleCentral])
  const offered = () => {
    pending.current = offer
    if (offer === 'browser') resetBrowserStatusCache() // hook pemilik status memuat ulang lalu menerbitkan `onAddBrowser`
    setOffer(null)
  }

  const dialog = offer && (
    <Dialog open onOpenChange={(o) => { if (!o) setOffer(null) }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{CAPABILITY_TEXT.offerTitle(CAPABILITIES[offer].title)}</DialogTitle></DialogHeader>
        <CapabilityOffer id={offer} onDone={offered} />
      </DialogContent>
    </Dialog>
  )
  return { setOffer, dialog }
}
