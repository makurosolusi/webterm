// "Review PR #…" inside the Source Control panel (F6 PR review bot). Starts a review, shows its
// progress and the open drafts with a Post review button. Posting is the human approval: the server
// decides the draft's Inbox gate and posts one review; approving it in the Inbox does the same.
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PRREVIEW_API, PRREVIEW_POLL_MS, PRREVIEW_TEXT as T, prReviewRequest, type DraftView, type PrReviewJob } from './prreview.client'

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function PrReviewSection({ root, gh, pollMs = PRREVIEW_POLL_MS }: { root: string; gh: boolean; pollMs?: number }): React.JSX.Element {
  const [pr, setPr] = useState('')
  const [jobs, setJobs] = useState<PrReviewJob[]>([])
  const [drafts, setDrafts] = useState<DraftView[]>([])
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await prReviewRequest<{ jobs: PrReviewJob[]; drafts: DraftView[] }>('GET', `${PRREVIEW_API}?repo=${encodeURIComponent(root)}`)
      setJobs(r.jobs)
      setDrafts(r.drafts)
    } catch (e) { setMsg(errText(e)) }
  }, [root])

  useEffect(() => { void load() }, [load])
  const running = jobs.some((j) => j.status === 'running')
  useEffect(() => {
    if (!running || pollMs <= 0) return
    const t = setTimeout(() => void load(), pollMs)
    return () => clearTimeout(t)
  }, [running, jobs, pollMs, load])

  const act = async (call: () => Promise<string | void>) => {
    setBusy(true)
    setMsg('')
    try {
      const m = await call()
      if (m) setMsg(m)
    } catch (e) { setMsg(errText(e)) } finally { setBusy(false); void load() }
  }
  const start = () => act(async () => { await prReviewRequest('POST', PRREVIEW_API, { repo: root, pr: Number(pr) }); setPr('') })
  const post = (d: DraftView) => act(async () => T.posted((await prReviewRequest<{ url: string }>('POST', `${PRREVIEW_API}/${encodeURIComponent(d.itemId)}/post`, {})).url))

  return (
    <section aria-label={T.title} className="scm-panel__prreview">
      <h4 className="scm-panel__group">{T.title}</h4>
      <p className="scm-panel__msg">{gh ? T.intro : T.noGh}</p>
      <div className="scm-panel__actions">
        <Input aria-label={T.prLabel} inputMode="numeric" placeholder="#" value={pr} onChange={(e) => setPr(e.target.value.replace(/\D/g, ''))} />
        <Button size="sm" disabled={busy || !gh || !pr} onClick={() => void start()}>{T.review(pr)}</Button>
      </div>
      {msg && <div className="scm-panel__msg" role="status">{msg}</div>}
      <ul className="scm-panel__list" aria-label="Reviews">
        {jobs.map((j) => <li key={j.id}>PR #{j.pr}: {T.status[j.status]}{j.error ? ` (${j.error})` : ''}</li>)}
      </ul>
      <ul className="scm-panel__list" aria-label="Draft reviews">
        {drafts.map((d) => (
          <li key={d.itemId}>
            <span>{T.draft(d)}</span>
            <Button size="sm" disabled={busy} title="Posts one review with inline comments to GitHub. Cannot be undone." onClick={() => void post(d)}>{T.post}</Button>
          </li>
        ))}
      </ul>
    </section>
  )
}
