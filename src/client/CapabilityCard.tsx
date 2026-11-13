// One feature as Settings rows (macOS System Settings): title + plain description left, ONE switch right; a
// feature waiting on setup shows a warning badge and its setup button; sub-options (only while on) are indented
// switch rows under it. Turning on something risky asks in the app AlertDialog (never `window.confirm`);
// turning off never asks.
import { useState, type ReactNode } from 'react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { CAPABILITIES, closure, dependents } from '../shared/featureCapabilities'
import type { CapabilityId, CapabilityView } from '../shared/featureCapabilities'
import { CAPABILITY_STATUS_LABEL, CAPABILITY_TEXT, joinTitles } from './capabilitiesLabels'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

export interface CapabilityCardProps {
  view: CapabilityView
  /** Semua kemampuan, untuk menghitung "Ikut mati". */
  all?: readonly CapabilityView[]
  busy?: boolean
  error?: string | null
  onToggle(enabled: boolean): void
  onSub?(key: string, on: boolean): void
  onStep?(kind: NonNullable<CapabilityView['step']>['kind']): void
  /** Extra sub-option shown while on (Files: "Edit and upload files"). */
  children?: ReactNode
}

/** Kemampuan yang menyala hanya lewat konfirmasi; katalog bersama baru menandai `dangerous` di tingkat sub-opsi. */
const DANGEROUS: readonly CapabilityId[] = ['autonomy']

const titles = (ids: readonly CapabilityId[]): string => joinTitles(ids.map((i) => CAPABILITIES[i].title))

/** Kartu kemampuan; presentasional, semua mutasi lewat callback. */
export function CapabilityCard(props: CapabilityCardProps): React.JSX.Element {
  const { view, all = [], busy = false, error, onToggle, onSub, onStep, children } = props
  // What waits for a "Turn on" in the dialog (null = no dialog); Cancel leaves everything off.
  const [asking, setAsking] = useState<{ label: string; run(): void } | null>(null)
  const confirmOn = (label: string, run: () => void): void => setAsking({ label, run })
  const on = view.status === 'on'
  const turnsOn = on ? [] : (view.alsoTurnsOn ?? closure(view.id).filter((i) => i !== view.id && all.find((v) => v.id === i)?.status !== 'on'))
  const turnsOff = on ? dependents(view.id).filter((d) => all.find((v) => v.id === d)?.status === 'on') : []
  // needs-step = sakelarnya sudah dinyalakan, tinggal satu langkah: tampil "nyala" supaya klik berarti
  // MATIKAN. Mematikan selalu boleh; menyalakan yang terkunci hanya lewat tombol langkah.
  const checked = on || view.status === 'needs-step'
  const switchId = `capability-switch-${view.id}`
  // Menyalakan yang berbahaya (kartu, langkah fixChain yang ikut menyalakannya, atau sub) wajib dikonfirmasi;
  // mematikan tidak pernah ditanya.
  const dangerous = DANGEROUS.includes(view.id)
  const toggle = (next: boolean): void => {
    if (next && dangerous) confirmOn(view.title, () => onToggle(true))
    else onToggle(next)
  }
  const step = (kind: NonNullable<CapabilityView['step']>['kind']): void => {
    if (kind === 'fixChain' && dangerous) confirmOn(view.title, () => onStep?.(kind))
    else onStep?.(kind)
  }
  const sub = (s: NonNullable<CapabilityView['subs']>[number], next: boolean): void => {
    if (next && s.dangerous) confirmOn(s.label, () => onSub?.(s.key, true))
    else onSub?.(s.key, next)
  }
  return (
    <section aria-label={view.title} aria-busy={busy} data-capability={view.id} data-field={`capability.${view.id}`} className="st-rows">
      <div className="st-field">
        <div className="st-field-text">
          <div className="st-title">
            <Label htmlFor={switchId} className="st-label">{view.title}</Label>
            {view.status === 'needs-step' ? (
              <span role="status" className="st-status" data-tone="warn">
                <span className="codicon codicon-warning" aria-hidden="true" />{CAPABILITY_STATUS_LABEL['needs-step']}
              </span>
            ) : null}
          </div>
          <p className="st-hint">{view.blurb}</p>
          {view.detail ? <p className="st-hint">{view.detail}</p> : null}
          {turnsOn.length > 0 ? <p className="st-hint">{CAPABILITY_TEXT.alsoTurnsOn} {titles(turnsOn)}</p> : null}
          {turnsOff.length > 0 ? <p className="st-hint">{CAPABILITY_TEXT.alsoTurnsOff} {titles(turnsOff)}</p> : null}
          {view.status === 'needs-step' && view.step ? (
            <Button size="sm" variant="secondary" className="mt-1.5" onClick={() => step(view.step!.kind)}>{view.step.label}</Button>
          ) : null}
          {error ? <p role="alert" className="st-hint st-save--error">{error}</p> : null}
        </div>
        <div className="st-control"><Switch id={switchId} checked={checked} disabled={busy} onCheckedChange={toggle} /></div>
      </div>
      {on && view.subs?.map((s) => (
        <div key={s.key} className="st-field st-field--sub">
          <div className="st-field-text"><Label htmlFor={`capability-sub-${view.id}-${s.key}`} className="st-label">{s.label}</Label></div>
          <div className="st-control">
            <Switch id={`capability-sub-${view.id}-${s.key}`} checked={s.on} disabled={busy} onCheckedChange={(v) => sub(s, v)} />
          </div>
        </div>
      ))}
      {on ? children : null}
      {asking ? (
        <AlertDialog open onOpenChange={(open) => { if (!open) setAsking(null) }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{CAPABILITY_TEXT.confirmTitle(asking.label)}</AlertDialogTitle>
              <AlertDialogDescription>{CAPABILITY_TEXT.confirmBody}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel autoFocus>{CAPABILITY_TEXT.confirmCancel}</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => { asking.run(); setAsking(null) }}>{CAPABILITY_TEXT.offerAction}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </section>
  )
}
