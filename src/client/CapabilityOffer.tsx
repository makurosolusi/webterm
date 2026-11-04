// Tawaran "tanya saat dibutuhkan": satu baris untuk menyalakan kemampuan yang masih mati.
// Langkah (needs-step) diselesaikan DI SINI, bukan dilempar ke pemanggil: Dock dan menu kanvas tidak
// punya Settings, jadi dulu tombol "Pilih lokasi Chrome" di tawaran tidak melakukan apa pun.
import { useEffect, useRef, useState } from 'react'
import type { CapabilityId, CapabilityView } from '../shared/featureCapabilities'
import { callCapabilities } from './capabilitiesApi'
import { CAPABILITY_TEXT } from './capabilitiesLabels'
import { ChromiumPathField } from './ChromiumPathField'
import { capabilityErrorMessage, useCapabilities } from './useCapabilities'
import { Button } from '@/components/ui/button'

export interface CapabilityOfferProps {
  id: CapabilityId
  /** Dipanggil begitu kemampuan menyala (lewat "Nyalakan" atau setelah langkahnya selesai). */
  onDone?(): void
  /** Langkah yang tidak bisa diselesaikan di tawaran (token Telegram). */
  onStep?(kind: NonNullable<CapabilityView['step']>['kind']): void
}

/** Tawaran menyalakan kemampuan; tidak merender apa pun bila sudah aktif atau belum termuat. */
export function CapabilityOffer({ id, onDone, onStep }: CapabilityOfferProps): React.JSX.Element | null {
  const { data, error, busyId, toggle, refresh } = useCapabilities()
  const [pathOpen, setPathOpen] = useState(false)
  const [stepError, setStepError] = useState<string | null>(null)
  const view = data?.capabilities.find((c) => c.id === id)
  // Pengguna sudah bertindak (Nyalakan / langkah) dan status server jadi `on` = selesai, apa pun jalurnya.
  const acted = useRef(false)
  const status = view?.status
  useEffect(() => {
    if (status === 'on' && acted.current) { acted.current = false; onDone?.() }
  }, [status, onDone])
  if (!view || view.status === 'on') return null
  const busy = busyId === id
  // onDone lewat efek status di atas, bukan hasil toggle: browser tanpa Chrome menjawab `needs-step`,
  // dan pemanggil yang menunggu node lahir tidak boleh diberi tahu "sudah menyala".
  const enable = async (): Promise<void> => {
    acted.current = true
    if (!(await toggle(id, true))) acted.current = false
  }
  const saveChromium = async (chromiumPath: string): Promise<void> => {
    try {
      await callCapabilities('/advanced', 'PUT', { chromiumPath })
      setStepError(null)
      await refresh()
    } catch (e) {
      setStepError(capabilityErrorMessage(e, CAPABILITY_TEXT.changeFailed))
    }
  }
  const step = (kind: NonNullable<CapabilityView['step']>['kind']): void => {
    if (kind === 'fixChain') void enable() // toggle biasa: server ikut menyalakan prasyaratnya
    else if (kind === 'chromiumPath') { acted.current = true; setPathOpen(true) }
    else onStep?.(kind)
  }
  const shownError = error ?? stepError
  return (
    <div aria-busy={busy} data-capability-offer={id} className="flex flex-col gap-1 text-xs">
      <p className="m-0">{view.blurb} {view.status === 'off' ? CAPABILITY_TEXT.offerQuestion : null}</p>
      {view.detail ? <p className="m-0 opacity-70">{view.detail}</p> : null}
      {view.status === 'needs-step' && view.step ? (
        pathOpen && data ? (
          <ChromiumPathField chromium={data.advanced.chromiumPath} save={saveChromium} redetect={refresh} />
        ) : (
          <Button size="sm" variant="secondary" className="self-start" disabled={busy} onClick={() => step(view.step!.kind)}>{view.step.label}</Button>
        )
      ) : (
        <Button size="sm" className="self-start" disabled={busy} onClick={() => { void enable() }}>{CAPABILITY_TEXT.offerAction}</Button>
      )}
      {shownError ? <p role="alert" className="m-0 text-destructive">{shownError}</p> : null}
    </div>
  )
}
