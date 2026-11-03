// Tawaran "tanya saat dibutuhkan": satu baris untuk menyalakan kemampuan yang masih mati.
import type { CapabilityId, CapabilityView } from '../shared/featureCapabilities'
import { CAPABILITY_TEXT } from './capabilitiesLabels'
import { useCapabilities } from './useCapabilities'
import { Button } from '@/components/ui/button'

export interface CapabilityOfferProps {
  id: CapabilityId
  onDone?(): void
  /** Dipanggil saat tombol langkah (needs-step) ditekan. */
  onStep?(kind: NonNullable<CapabilityView['step']>['kind']): void
}

/** Tawaran menyalakan kemampuan; tidak merender apa pun bila sudah aktif atau belum termuat. */
export function CapabilityOffer({ id, onDone, onStep }: CapabilityOfferProps): React.JSX.Element | null {
  const { data, error, busyId, toggle } = useCapabilities()
  const view = data?.capabilities.find((c) => c.id === id)
  if (!view || view.status === 'on') return null
  const busy = busyId === id
  const enable = async (): Promise<void> => { if (await toggle(id, true)) onDone?.() }
  return (
    <div aria-busy={busy} data-capability-offer={id} className="flex flex-col gap-1 text-xs">
      <p className="m-0">{view.blurb} {view.status === 'off' ? CAPABILITY_TEXT.offerQuestion : null}</p>
      {view.detail ? <p className="m-0 opacity-70">{view.detail}</p> : null}
      {view.status === 'needs-step' && view.step ? (
        <Button size="sm" variant="secondary" className="self-start" onClick={() => onStep?.(view.step!.kind)}>{view.step.label}</Button>
      ) : (
        <Button size="sm" className="self-start" disabled={busy} onClick={() => { void enable() }}>{CAPABILITY_TEXT.offerAction}</Button>
      )}
      {error ? <p role="alert" className="m-0 text-destructive">{error}</p> : null}
    </div>
  )
}
