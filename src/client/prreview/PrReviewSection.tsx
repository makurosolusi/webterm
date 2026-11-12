// "Review PR #…" inside the Source Control panel (F6 PR review bot). Starts a review, shows its
// progress and the open drafts with a Post review button. Posting is the human approval: the server
// decides the draft's Inbox gate and posts one review; approving it in the Central chat does the same.
import { useCallback, useEffect, useState } from 'react'
import { ActionButton, ActionResult, useAction } from '@/components/ui/action'
import { IconTooltip } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { PRREVIEW_API, PRREVIEW_POLL_MS, PRREVIEW_TEXT as T, prReviewRequest, type DraftView, type PrReviewJob } from './prreview.client'

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const TEXT = { starting: 'Starting review…', started: (pr: string) => `Review of PR #${pr} started`, posting: 'Posting…', loadFailed: 'Cannot load reviews' } as const

/** One draft with its own Post review: busy, then the posted URL, or the failure with Retry. */
function DraftRow({ d, locked, done }: { d: DraftView; locked: boolean; done(): void }): React.JSX.Element {
  const post = useAction(async () => {
    try { return T.posted((await prReviewRequest<{ url: string }>('POST', `${PRREVIEW_API}/${encodeURIComponent(d.itemId)}/post`, {})).url) } finally { done() }
  }, { label: T.post, success: (m) => m })
  return (
    <li>
      <span>{T.draft(d)}</span>
      <IconTooltip label="Posts one review with inline comments to GitHub. Cannot be undone." disabled={locked} disabledReason="another action is running">
        <ActionButton size="sm" action={post} busyLabel={TEXT.posting} disabled={locked}>{T.post}</ActionButton>
      </IconTooltip>
      <ActionResult action={post} />
    </li>
  )
}

export function PrReviewSection({ root, gh, pollMs = PRREVIEW_POLL_MS }: { root: string; gh: boolean; pollMs?: number }): React.JSX.Element {
  const [pr, setPr] = useState('')
  const [jobs, setJobs] = useState<PrReviewJob[]>([])
  const [drafts, setDrafts] = useState<DraftView[]>([])
  const [loadError, setLoadError] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await prReviewRequest<{ jobs: PrReviewJob[]; drafts: DraftView[] }>('GET', `${PRREVIEW_API}?repo=${encodeURIComponent(root)}`)
      setJobs(r.jobs)
      setDrafts(r.drafts)
      setLoadError('')
    } catch (e) { setLoadError(errText(e)) }
  }, [root])

  useEffect(() => { void load() }, [load])
  const running = jobs.some((j) => j.status === 'running')
  useEffect(() => {
    if (!running || pollMs <= 0) return
    const t = setTimeout(() => void load(), pollMs)
    return () => clearTimeout(t)
  }, [running, jobs, pollMs, load])

  const start = useAction(async () => {
    const n = pr
    try { await prReviewRequest('POST', PRREVIEW_API, { repo: root, pr: Number(n) }); setPr(''); return n } finally { void load() }
  }, { label: T.review(pr), success: (n) => TEXT.started(n) })

  return (
    <section aria-label={T.title} className="scm-panel__prreview">
      <h4 className="scm-panel__group">{T.title}</h4>
      <p className="scm-panel__msg">{gh ? T.intro : T.noGh}</p>
      <div className="scm-panel__actions">
        <Input aria-label={T.prLabel} inputMode="numeric" placeholder="#" value={pr} onChange={(e) => setPr(e.target.value.replace(/\D/g, ''))} />
        <ActionButton size="sm" action={start} busyLabel={TEXT.starting} disabled={!gh || !pr}>{T.review(pr)}</ActionButton>
      </div>
      <ActionResult action={start} />
      {loadError && <div className="scm-panel__msg" role="alert">{`${TEXT.loadFailed}: ${loadError}`}</div>}
      <ul className="scm-panel__list" aria-label="Reviews">
        {jobs.map((j) => <li key={j.id}>PR #{j.pr}: {T.status[j.status]}{j.error ? ` (${j.error})` : ''}</li>)}
      </ul>
      <ul className="scm-panel__list" aria-label="Draft reviews">
        {drafts.map((d) => <DraftRow key={d.itemId} d={d} locked={start.busy} done={() => void load()} />)}
      </ul>
    </section>
  )
}
