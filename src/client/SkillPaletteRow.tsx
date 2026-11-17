// One row of the canvas Skills panel: the add button (drag onto the canvas / agent, or press Enter) beside a details
// toggle and the inline on/off switch; the open detail sits under the row. A skill that is off is not addable.
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { type KeyboardEvent, type ReactNode, useId, useRef } from 'react'
import { CL } from './central/centralLabels'
import type { CentralControlClient, SkillReviewRow } from './central/centralControlTypes'
import { titleOf } from './central/skillLibraryModel'
import { useSkillSwitch } from './central/useSkillSwitch'
import { setSkillDrag } from './skillPalette.drag'
import { SP } from './skillPalette.labels'

interface Props {
  row: SkillReviewRow
  client: CentralControlClient
  attached: boolean
  open: boolean
  onToggle: () => void
  onChanged: () => void
  onAdd: () => void
  /** Detail under the row; gets a close function that also returns focus to the details button. */
  detail: (close: () => void) => ReactNode
}

export default function SkillPaletteRow({ row, client, attached, open, onToggle, onChanged, onAdd, detail }: Props) {
  const { record, description } = row
  const detailId = useId()
  const toggle = useRef<HTMLButtonElement>(null)
  const { on, busy, error, flip } = useSkillSwitch(row, client, onChanged)
  const title = titleOf(row)
  const addable = record.enabled !== false
  const close = (): void => { onToggle(); toggle.current?.focus() }
  const onKeyDown = (e: KeyboardEvent): void => { if (e.key === 'Escape' && open) { e.stopPropagation(); close() } }
  const body = (
    <>
      <span className="sp__line">
        <strong className="sp__title">{title}</strong>
        {record.origin === 'builtin' && <span className="ccp-badge">{CL.skillBuiltIn}</span>}
        {!addable && <span className="ccp-badge">{CL.skillDisabledBadge}</span>}
        {attached && <span className="sp__attached"><span className="codicon codicon-check" aria-hidden="true" />{SP.attached}</span>}
      </span>
      <span className="sp__meta"><code className="sp__slug">{record.name}</code><span>v{record.version}</span></span>
      {description && <span className="sp__desc">{description}</span>}
    </>
  )
  return (
    <li className="sp__item" data-open={open || undefined} onKeyDown={onKeyDown}>
      <div className="sp__main">
        {addable
          ? (
            <Button
              type="button" variant="ghost" className="sp__row" draggable aria-label={SP.addAria(title, attached)} data-attached={attached || undefined}
              onDragStart={(e) => setSkillDrag(e.dataTransfer, { name: record.name, version: record.version })} onClick={onAdd}
            >{body}</Button>
          )
          : <div className="sp__row sp__row--static">{body}</div>}
        <div className="sp__ctl">
          <Button ref={toggle} type="button" variant="ghost" size="icon-sm" aria-expanded={open} aria-controls={open ? detailId : undefined} aria-label={`${CL.skillView} ${record.name} ${record.version}`} onClick={onToggle}>
            <span className={`codicon codicon-chevron-${open ? 'down' : 'right'}`} aria-hidden="true" />
          </Button>
          <Switch checked={on} disabled={busy} aria-label={CL.skillRowEnabled(record.name)} onCheckedChange={flip} />
        </div>
      </div>
      {error && <p role="alert" className="ccp-error">{error}</p>}
      {open && <div id={detailId} className="sp__detail">{detail(close)}</div>}
    </li>
  )
}
