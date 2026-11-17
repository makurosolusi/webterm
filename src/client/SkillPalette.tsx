// Skills view of the side bar: the whole home of CANVAS skills (Control > Skills is Central's only). Header with
// "Write with an agent", search + status filter, rows with an inline switch and a detail under the row, and the
// canvas drafts waiting for the human's typed approval. A row becomes a skill node three ways, all through the board's
// one `addSkillNode`: drag it onto the canvas (the drop handler places it, or cables it when it lands on an agent) or press
// the row (Enter). With exactly one agent selected, each row shows whether that agent already has the skill.
import { useEffect, useMemo, useState } from 'react'
import type { Edge, Node } from '@xyflow/react'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { MAX_ATTACHED_SKILLS } from '../shared/skillPorts'
import { SKILL_AUTHOR_ACTIVITY } from './agentChat/skillAuthor.events'
import { CL } from './central/centralLabels'
import { SKILLS_OFF, centralControlApi } from './central/centralControlApi'
import type { CentralControlClient, SkillReviewRow } from './central/centralControlTypes'
import { useLoad } from './central/centralLoad'
import SkillDetail from './central/SkillDetail'
import SkillReviewList from './central/SkillReview'
import { SKILL_FILTERS, type SkillFilter, countByFilter, matchesFilter, needsReview, searchRows } from './central/skillLibraryModel'
import { useNodeActions } from './nodeActions'
import { openCentralTab } from './secondarySideBar.store'
import SkillPaletteRow from './SkillPaletteRow'
import { attachedCount, attachedSkillNames, selectedSkillHost } from './skillNode.add'
import { SP } from './skillPalette.labels'
import { hostName, reportSkillAdd } from './skillPalette.notice'
import './skillPalette.css'

const SKELETON_ROWS = [0, 1, 2]
const OPEN: readonly string[] = ['proposed', 'evaluated', 'pending_approval']
const keyOf = (r: SkillReviewRow): string => `${r.record.name}@${r.record.version}`

export default function SkillPalette({ nodes, edges, client = centralControlApi }: { nodes: readonly Node[]; edges: readonly Edge[]; client?: CentralControlClient }) {
  const list = useLoad((s) => client.listSkills(s))
  // One subscription here, in the owner of the list: a canvas author chat that finishes a turn may have proposed the first draft, when no draft card is mounted yet.
  const reload = list.reload
  useEffect(() => {
    window.addEventListener(SKILL_AUTHOR_ACTIVITY, reload)
    return () => window.removeEventListener(SKILL_AUTHOR_ACTIVITY, reload)
  }, [reload])
  const { addSkillNode, openSkillAuthor } = useNodeActions()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<SkillFilter>('all')
  const [selected, setSelected] = useState<string | null>(null)
  const host = useMemo(() => selectedSkillHost(nodes as Node[]), [nodes])
  const attached = useMemo(() => (host ? attachedSkillNames(nodes, edges, host.id) : null), [host, nodes, edges])
  const count = host ? attachedCount(edges, host.id) : 0

  const off = list.code === SKILLS_OFF
  const rows = useMemo(() => (list.data ?? []).filter((r) => r.record.audience === 'canvas'), [list.data])
  const searched = searchRows(rows, query)
  const counts = countByFilter(searched)
  const shown = searched.filter((r) => matchesFilter(r, filter))
  const active = rows.filter((r) => r.record.status === 'active')
  const listed = shown.filter((r) => r.record.status === 'active').sort((a, b) => a.record.name.localeCompare(b.record.name))
  const review = shown.filter(needsReview)
  const drafts = rows.filter((r) => OPEN.includes(r.record.status)).length
  const hasOpen = (d: SkillReviewRow): boolean => rows.some((r) => r.record.name === d.record.name && OPEN.includes(r.record.status))

  const add = (r: SkillReviewRow): void => {
    const res = addSkillNode?.({ name: r.record.name, version: r.record.version }) ?? { status: 'no_board' as const }
    reportSkillAdd(res, host ? hostName(host) : undefined)
  }
  // "Ask the agent ..." of the open detail: a built-in is read only and only offers a variant (a NEW name); the author is a chat node on this board.
  const reviseOf = (d: SkillReviewRow) => {
    const { name, origin, status } = d.record
    const reason = !openSkillAuthor ? SP.writeNoBoard : status !== 'active' ? CL.skillReviseInactive : hasOpen(d) ? CL.skillEditOpenDraft : undefined
    const label = origin === 'builtin' ? CL.skillAuthorVariant : CL.skillAuthorRevise
    return <>
      {origin === 'builtin' && <small>{CL.skillVariantHint(name)}</small>}
      <Button type="button" size="sm" variant="secondary" disabled={reason !== undefined} aria-describedby={reason ? 'sp-revise-reason' : undefined} onClick={() => openSkillAuthor?.(name)}>{label}</Button>
      {reason && <small id="sp-revise-reason">{reason}</small>}
    </>
  }
  const detailOf = (r: SkillReviewRow) => (close: () => void) => <SkillDetail key={`${keyOf(r)}:${r.record.enabled}`} row={r} client={client} onClose={close} onChanged={reload} revise={reviseOf(r)} />

  return (
    <section className="sp" aria-label={SP.title} aria-busy={list.loading && !list.data ? true : undefined}>
      <header className="sp__head">
        <div className="sp__titles"><h3>{SP.title}</h3><p>{SP.subtitle}</p></div>
        {!off && (
          <IconButton label={CL.skillsRefresh} size="icon-sm" disabled={list.loading} onClick={reload}>
            <span className={`codicon codicon-refresh${list.loading ? ' codicon-modifier-spin' : ''}`} aria-hidden="true" />
          </IconButton>
        )}
      </header>
      {!off && (
        <div className="sp__write">
          <Button type="button" size="sm" variant="secondary" disabled={!openSkillAuthor} aria-describedby={openSkillAuthor ? undefined : 'sp-write-reason'} onClick={() => openSkillAuthor?.()}>
            <span className="codicon codicon-add" aria-hidden="true" />{CL.skillAuthorWrite}
          </Button>
          {drafts > 0 && <span className="ccp-badge">{CL.skillDraftsBadge(drafts)}</span>}
          {!openSkillAuthor && <small id="sp-write-reason">{SP.writeNoBoard}</small>}
        </div>
      )}
      <p className="sp__hint">{SP.centralPointer} <Button type="button" size="xs" variant="link" onClick={() => openCentralTab('skills')}>{SP.openCentralSkills}</Button></p>
      {list.data && !off && active.length > 0 && (
        <div className="sp__tools">
          <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={SP.search} aria-label={SP.search} />
          <div className="sp__seg" role="group" aria-label={CL.skillsFilterLabel}>
            {SKILL_FILTERS.map((f) => (
              <Button key={f} type="button" size="xs" variant={filter === f ? 'secondary' : 'ghost'} aria-pressed={filter === f} onClick={() => setFilter(f)}>{CL.skillsFilter[f]}<small>{counts[f]}</small></Button>
            ))}
          </div>
          {host && <p className="sp__agent" aria-live="polite">{SP.header(hostName(host), count, MAX_ATTACHED_SKILLS)}</p>}
          <p className="sp__hint">{SP.dragHint}</p>
        </div>
      )}
      {list.loading && !list.data && (
        <div><span role="status" className="sr-only">{SP.loading}</span>{SKELETON_ROWS.map((i) => <div key={i} className="sp__skeleton" aria-hidden="true" />)}</div>
      )}
      {list.error && !off && (
        <div className="sp__state"><p role="alert">{SP.failed}</p><Button type="button" size="sm" variant="secondary" onClick={reload}>{SP.retry}</Button></div>
      )}
      {off && <p className="sp__state">{SP.off}</p>}
      {list.data && !off && active.length === 0 && (
        <div className="sp__state"><p>{SP.empty}</p><Button type="button" size="sm" variant="secondary" disabled={!openSkillAuthor} onClick={() => openSkillAuthor?.()}>{CL.skillAuthorWrite}</Button></div>
      )}
      {list.data && !off && active.length > 0 && listed.length === 0 && review.length === 0 && <p className="sp__state">{SP.noMatch}</p>}
      {listed.length > 0 && (
        <ul className="sp__list" aria-label={SP.list}>
          {listed.map((r) => (
            <SkillPaletteRow
              key={keyOf(r)} row={r} client={client} attached={attached?.has(r.record.name) === true} open={keyOf(r) === selected}
              onToggle={() => setSelected(keyOf(r) === selected ? null : keyOf(r))} onChanged={reload} onAdd={() => add(r)} detail={detailOf(r)}
            />
          ))}
        </ul>
      )}
      {list.data && !off && review.length > 0 && (
        <section className="sp__review" aria-labelledby="sp-review-h">
          <h4 id="sp-review-h">{CL.skillsReviewHeading}</h4>
          <SkillReviewList rows={review} client={client} onDone={reload} />
        </section>
      )}
    </section>
  )
}
