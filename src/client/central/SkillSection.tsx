// A collapsible library section: one-line header (title, count, purpose line, actions) over its rows.
import { Button } from '@/components/ui/button'
import { type ReactNode, useId, useState } from 'react'
import { CL } from './centralLabels'

interface Props {
  title: string
  count: number
  purpose: string
  /** Right side of the header: badges and the "Write with an agent" button. */
  actions: ReactNode
  children: ReactNode
}

export default function SkillSection({ title, count, purpose, actions, children }: Props) {
  const [open, setOpen] = useState(true)
  const headingId = useId()
  const bodyId = useId()
  return (
    <section className="ccp-skill-section" aria-labelledby={headingId}>
      <header className="ccp-skill-section__head">
        <div className="ccp-skill-section__titles">
          <h4>
            <Button type="button" variant="ghost" aria-expanded={open} aria-controls={bodyId} aria-label={CL.skillSectionToggle(title)} onClick={() => setOpen(!open)}>
              <span className={`codicon codicon-chevron-${open ? 'down' : 'right'}`} aria-hidden="true" />
              <span id={headingId}>{title}</span> <span className="ccp-skill-section__count">{count}</span>
            </Button>
          </h4>
          <p>{purpose}</p>
        </div>
        <div className="ccp-skill-section__actions">{actions}</div>
      </header>
      <div id={bodyId} hidden={!open}>{children}</div>
    </section>
  )
}
