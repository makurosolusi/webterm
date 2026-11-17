// Skills view of the side bar (n8n node panel / Node-RED palette): the active, switched-on canvas skills, searchable.
// A row becomes a skill node three ways, all through the board's one `addSkillNode`: drag it onto the canvas (the canvas drop
// handler places it, or cables it when it lands on an agent), or press the row (Enter on the keyboard). With exactly one
// agent selected, each row shows whether that agent already has the skill and the header counts its skills.
import { useMemo, useState } from 'react'
import type { Edge, Node } from '@xyflow/react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MAX_ATTACHED_SKILLS } from '../shared/skillPorts'
import { useNodeActions } from './nodeActions'
import { openCentralTab } from './secondarySideBar.store'
import { attachedCount, attachedSkillNames, selectedSkillHost } from './skillNode.add'
import { useCanvasSkills, type CanvasSkill } from './skillNode.api'
import { attachable } from './skillNode.model'
import { setSkillDrag } from './skillPalette.drag'
import { SP } from './skillPalette.labels'
import { hostName, reportSkillAdd } from './skillPalette.notice'
import { matchesSkill } from './skillPalette.search'
import './skillPalette.css'

const SKELETON_ROWS = [0, 1, 2]

export default function SkillPalette({ nodes, edges }: { nodes: readonly Node[]; edges: readonly Edge[] }) {
  const lib = useCanvasSkills()
  const { addSkillNode } = useNodeActions()
  const [query, setQuery] = useState('')
  const host = useMemo(() => selectedSkillHost(nodes as Node[]), [nodes])
  const attached = useMemo(() => (host ? attachedSkillNames(nodes, edges, host.id) : null), [host, nodes, edges])
  const count = host ? attachedCount(edges, host.id) : 0
  const rows = useMemo(() => (lib.status === 'ready' ? attachable(lib.skills) : []), [lib])
  const shown = rows.filter((s) => matchesSkill(s, query))

  const add = (s: CanvasSkill): void => {
    const r = addSkillNode?.({ name: s.name, version: s.version }) ?? { status: 'no_board' as const }
    reportSkillAdd(r, host ? hostName(host) : undefined)
  }

  return (
    <section className="sp" aria-label={SP.title} aria-busy={lib.status === 'loading' ? true : undefined}>
      <div className="sp__tools">
        <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={SP.search} aria-label={SP.search} />
        {host && <p className="sp__agent" aria-live="polite">{SP.header(hostName(host), count, MAX_ATTACHED_SKILLS)}</p>}
        {lib.status === 'ready' && rows.length > 0 && <p className="sp__hint">{SP.dragHint}</p>}
      </div>
      {lib.status === 'loading' && (
        <div><span role="status" className="sr-only">{SP.loading}</span>{SKELETON_ROWS.map((i) => <div key={i} className="sp__skeleton" aria-hidden="true" />)}</div>
      )}
      {lib.status === 'error' && (
        <div className="sp__state"><p role="alert">{SP.failed}</p><Button type="button" size="sm" variant="secondary" onClick={lib.reload}>{SP.retry}</Button></div>
      )}
      {lib.status === 'off' && <p className="sp__state">{SP.off}</p>}
      {lib.status === 'ready' && rows.length === 0 && (
        <div className="sp__state"><p>{SP.empty}</p><Button type="button" size="sm" variant="secondary" onClick={() => openCentralTab('skills')}>{SP.openSkillsTab}</Button></div>
      )}
      {lib.status === 'ready' && rows.length > 0 && shown.length === 0 && <p className="sp__state">{SP.noMatch}</p>}
      {shown.length > 0 && (
        <ul className="sp__list" aria-label={SP.list}>
          {shown.map((s) => {
            const title = s.title || s.name
            const on = attached?.has(s.name) === true
            return (
              <li key={s.name}>
                <Button
                  type="button" variant="ghost" className="sp__row" draggable aria-label={SP.addAria(title, on)} data-attached={on || undefined}
                  onDragStart={(e) => setSkillDrag(e.dataTransfer, { name: s.name, version: s.version })}
                  onClick={() => add(s)}
                >
                  <span className="sp__line">
                    <strong className="sp__title">{title}</strong>
                    {on && <span className="sp__attached"><span className="codicon codicon-check" aria-hidden="true" />{SP.attached}</span>}
                  </span>
                  <span className="sp__meta"><code className="sp__slug">{s.name}</code><span>v{s.version}</span></span>
                  {s.description && <span className="sp__desc">{s.description}</span>}
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
