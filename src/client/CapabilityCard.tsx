// Kartu satu kemampuan: judul, blurb, SATU sakelar, status, langkah, dan sub-opsi (hanya saat aktif).
import { CAPABILITIES, closure, dependents } from '../shared/featureCapabilities'
import type { CapabilityId, CapabilityView } from '../shared/featureCapabilities'
import { CAPABILITY_STATUS_LABEL, CAPABILITY_TEXT, joinTitles } from './capabilitiesLabels'
import { CENTRAL_TEXT } from './centralSettingsLabels'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
}

/** Kemampuan yang menyala hanya lewat konfirmasi; katalog bersama baru menandai `dangerous` di tingkat sub-opsi. */
const DANGEROUS: readonly CapabilityId[] = ['autonomy']
/** Konfirmasi menyalakan hal berbahaya (pola `window.confirm` WorkspaceBar.tsx:101-105; dialog ditekan = false = tetap mati). */
const confirmOn = (label: string): boolean => window.confirm(CAPABILITY_TEXT.confirmDangerous(label))

const titles = (ids: readonly CapabilityId[]): string => joinTitles(ids.map((i) => CAPABILITIES[i].title))

/** Kartu kemampuan; presentasional, semua mutasi lewat callback. */
export function CapabilityCard(props: CapabilityCardProps): React.JSX.Element {
  const { view, all = [], busy = false, error, onToggle, onSub, onStep } = props
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
    if (next && dangerous && !confirmOn(view.title)) return
    onToggle(next)
  }
  const step = (kind: NonNullable<CapabilityView['step']>['kind']): void => {
    if (kind === 'fixChain' && dangerous && !confirmOn(view.title)) return
    onStep?.(kind)
  }
  const sub = (s: NonNullable<CapabilityView['subs']>[number], next: boolean): void => {
    if (next && s.dangerous && !confirmOn(s.label)) return
    onSub?.(s.key, next)
  }
  return (
    <section aria-label={view.title} aria-busy={busy} data-capability={view.id} data-field={`capability.${view.id}`} className="flex flex-col gap-1 border-b border-(--vscode-widget-border,transparent) py-3">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={switchId} className="text-[13px] font-semibold">{view.title}</Label>
        <div className="flex items-center gap-2">
          <span role="status" className="text-xs opacity-70">{CAPABILITY_STATUS_LABEL[view.status]}</span>
          <Switch id={switchId} checked={checked} disabled={busy} onCheckedChange={toggle} />
        </div>
      </div>
      <p className="m-0 text-xs opacity-80">{view.blurb}</p>
      {view.detail ? <p className="m-0 text-xs opacity-70">{view.detail}</p> : null}
      {view.status === 'needs-step' && view.step ? (
        <Button size="sm" variant="secondary" className="self-start" onClick={() => step(view.step!.kind)}>{view.step.label}</Button>
      ) : null}
      {turnsOn.length > 0 ? <p className="m-0 text-xs opacity-70">{CAPABILITY_TEXT.alsoTurnsOn} {titles(turnsOn)}</p> : null}
      {turnsOff.length > 0 ? <p className="m-0 text-xs opacity-70">{CAPABILITY_TEXT.alsoTurnsOff} {titles(turnsOff)}</p> : null}
      {on && view.subs?.map((s) => (
        <div key={s.key} className="flex items-center gap-2">
          <Checkbox id={`capability-sub-${view.id}-${s.key}`} checked={s.on} disabled={busy} onCheckedChange={(v) => sub(s, v === true)} />
          <Label htmlFor={`capability-sub-${view.id}-${s.key}`} className="text-xs">{s.label}</Label>
        </div>
      ))}
      {error ? <p role="alert" className="m-0 text-xs text-destructive">{error}</p> : null}
    </section>
  )
}

/** Capabilities › Central Agent: status + a link; its switches are in Settings › Central Agent. */
export function CentralSummaryRow({ view, onOpen }: { view: CapabilityView; onOpen?(): void }): React.JSX.Element {
  return (
    <section aria-label={CENTRAL_TEXT.summaryTitle} data-capability="central" data-field="capability.central" className="flex items-center justify-between gap-2 border-b border-(--vscode-widget-border,transparent) py-3">
      <span className="text-[13px] font-semibold">{CENTRAL_TEXT.summaryTitle}</span>
      <div className="flex items-center gap-2">
        <span role="status" className="text-xs opacity-70">{CAPABILITY_STATUS_LABEL[view.status]}</span>
        <Button size="xs" variant="link" className="px-0" disabled={!onOpen} onClick={onOpen}>{CENTRAL_TEXT.summaryLink}</Button>
      </div>
    </section>
  )
}
