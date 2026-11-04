// Tawaran menyalakan browser untuk baris "Open in canvas browser" saat kemampuan browser mati.
// Pola sama dengan tawaran di Dock/menu kanvas: tampilkan CapabilityOffer, lalu jalankan aksi aslinya
// (buka link ini) begitu `openBrowserAt` terbit setelah status browser dimuat ulang.
// Store modul, bukan state: baris menu dibuat oleh TerminalNode/AgentNode, host-nya satu di App.
import { useEffect, useSyncExternalStore } from 'react'
import { CAPABILITIES } from '../shared/featureCapabilities'
import type { OpenBrowserReq } from './browser.open.plan'
import { resetBrowserStatusCache } from './browser.feature'
import { CapabilityOffer } from './CapabilityOffer'
import { CAPABILITY_TEXT } from './capabilitiesLabels'
import { useNodeActions } from './nodeActions'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

let asked: OpenBrowserReq | null = null // dialog tawaran terbuka untuk link ini
let pending: OpenBrowserReq | null = null // browser sudah menyala, menunggu `openBrowserAt`
const listeners = new Set<() => void>()
const setAsked = (next: OpenBrowserReq | null): void => {
  asked = next
  for (const l of listeners) l()
}
const subscribe = (cb: () => void): (() => void) => { listeners.add(cb); return () => { listeners.delete(cb) } }

/** Minta tawaran "Nyalakan browser"; link dibuka otomatis setelah browser menyala. */
export function requestBrowserOffer(req: OpenBrowserReq): void { setAsked(req) }

/** Host dialog tawaran; dipasang sekali di dalam NodeActionsProvider. */
export function BrowserLinkOfferHost(): React.JSX.Element | null {
  const req = useSyncExternalStore(subscribe, () => asked)
  const { openBrowserAt } = useNodeActions()
  useEffect(() => {
    if (!pending || !openBrowserAt) return
    const r = pending
    pending = null
    openBrowserAt(r)
  }, [openBrowserAt])
  if (!req) return null
  const done = (): void => {
    pending = req
    resetBrowserStatusCache() // hook pemilik status memuat ulang lalu menerbitkan `openBrowserAt`
    setAsked(null)
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) setAsked(null) }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{CAPABILITY_TEXT.offerTitle(CAPABILITIES.browser.title)}</DialogTitle></DialogHeader>
        <CapabilityOffer id="browser" onDone={done} />
      </DialogContent>
    </Dialog>
  )
}
