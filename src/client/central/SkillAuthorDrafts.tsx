// "Drafts from Central": the open drafts Central proposed for a Central skill, read from Control > Skills' own list. Each
// card is the normal review card (diff against the active version, lint, typed approval, Reject). Changes are asked of the
// agent, never typed here. No polling: a finished chat turn and the Refresh button reload. (Canvas drafts are reviewed in the canvas Skills panel.)
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { CL } from './centralLabels'
import { SKILLS_OFF } from './centralControlApi'
import type { CentralControlClient, SkillReviewRow } from './centralControlTypes'
import { type Loaded, useLoad } from './centralLoad'
import { centralDraftsOf } from './skillAuthorModel'
import { SD } from './skillDetail.labels'
import SkillReviewList from './SkillReview'
import './skillDetail.css'

interface CardProps {
  title: string
  empty: string
  list: Loaded<SkillReviewRow[]>
  drafts: SkillReviewRow[]
  client: CentralControlClient
  /** A draft was approved or rejected: reload the library. */
  onChanged: () => void
  /** The host already shows the list's load error and loading line (the Skills tab does): the card then stays quiet about them. */
  hostShowsStatus?: boolean
}

function DraftsCard({ title, empty, list, drafts, client, onChanged, hostShowsStatus = false }: CardProps) {
  const done = (): void => { list.reload(); onChanged() }
  return (
    <section className="ccp-card" aria-label={title}>
      <header className="skd-drafts-head">
        <h4>{title}</h4>
        {list.data && <span className="skd-drafts-count">{SD.draftsCount(drafts.length)}</span>}
        <span className="skd-drafts-spacer" />
        <IconButton label={CL.skillAuthorRefresh} size="icon-sm" disabled={list.loading} onClick={list.reload}>
          <span className={`codicon codicon-refresh${list.loading ? ' codicon-modifier-spin' : ''}`} aria-hidden="true" />
        </IconButton>
      </header>
      {list.code === SKILLS_OFF && !hostShowsStatus && <p className="skd-muted">{CL.skillsOff}</p>}
      {list.error && list.code !== SKILLS_OFF && !hostShowsStatus && (
        <div><p role="alert" className="ccp-error">{list.error}</p><Button type="button" size="sm" variant="secondary" onClick={list.reload}>{CL.skillsRetry}</Button></div>
      )}
      {list.loading && !list.data && !hostShowsStatus && <p role="status" className="skd-muted">{CL.loading}</p>}
      {list.data && drafts.length === 0 && <p className="skd-muted">{empty}</p>}
      <SkillReviewList rows={drafts} client={client} onDone={done} />
    </section>
  )
}

/** "Drafts from Central": reads the Skills tab's list (one load, no second request) and the library (SkillLibrary) reloads it when a Central skill-author chat finishes a turn. */
export function CentralDraftsPanel({ list, client }: { list: Loaded<SkillReviewRow[]>; client: CentralControlClient }) {
  const reload = list.reload
  return <DraftsCard title={CL.centralDrafts} empty={CL.centralDraftsEmpty} list={list} drafts={centralDraftsOf(list.data ?? [])} client={client} onChanged={reload} hostShowsStatus />
}
