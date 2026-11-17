// One dense library row: title + slug, version, inline on/off switch, 2-line description. Selecting it opens the detail
// right under it (the library keeps one open at a time); Esc closes and returns focus to the row.
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { type KeyboardEvent, type ReactNode, useId, useRef } from 'react'
import { CL } from './centralLabels'
import type { CentralControlClient, SkillReviewRow } from './centralControlTypes'
import { isOff, titleOf } from './skillLibraryModel'
import { useSkillSwitch } from './useSkillSwitch'

interface Props {
  row: SkillReviewRow
  client: CentralControlClient
  open: boolean
  onToggle: () => void
  /** The switch changed on the server: reload the list. */
  onChanged: () => void
  /** Detail under the row; gets a close function that also returns focus to the row. */
  detail: (close: () => void) => ReactNode
}

/** Only a non-normal state earns a badge: Built-in origin, or a status other than active (or switched off). */
function badgesOf(row: SkillReviewRow): string[] {
  const { origin, status } = row.record
  const out: string[] = origin === 'builtin' ? [CL.skillBuiltIn] : []
  if (status !== 'active') out.push(CL.skillStatusBadge[status] ?? status)
  else if (isOff(row)) out.push(CL.skillDisabledBadge)
  return out
}

export default function SkillRow({ row, client, open, onToggle, onChanged, detail }: Props) {
  const { record, description } = row
  const detailId = useId()
  const button = useRef<HTMLButtonElement>(null)
  const { on, busy, error, flip } = useSkillSwitch(row, client, onChanged)
  const title = titleOf(row)
  const close = (): void => { onToggle(); button.current?.focus() }
  const onKeyDown = (e: KeyboardEvent): void => { if (e.key === 'Escape' && open) { e.stopPropagation(); close() } }
  return (
    <li className="ccp-skill-row" data-open={open || undefined} onKeyDown={onKeyDown}>
      <div className="ccp-skill-row__main">
        <Button ref={button} type="button" variant="ghost" className="ccp-skill-row__btn" aria-expanded={open} aria-controls={open ? detailId : undefined} aria-label={`${CL.skillView} ${record.name} ${record.version}`} onClick={onToggle}>
          <span className="ccp-skill-row__title">
            <strong>{title}</strong>
            {title !== record.name && <code>{record.name}</code>}
            {badgesOf(row).map((b) => <span key={b} className="ccp-badge">{b}</span>)}
          </span>
          {description && <span className="ccp-skill-row__desc">{description}</span>}
        </Button>
        <span className="ccp-skill-row__ver">v{record.version}</span>
        {record.status === 'active'
          ? <Switch checked={on} disabled={busy} aria-label={CL.skillRowEnabled(record.name)} onCheckedChange={flip} />
          : <span />}
      </div>
      {error && <p role="alert" className="ccp-error">{error}</p>}
      {open && <div id={detailId} className="ccp-skill-row__detail">{detail(close)}</div>}
    </li>
  )
}
