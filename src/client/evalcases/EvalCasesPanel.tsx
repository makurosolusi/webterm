// Eval cases section of Settings › Developer (PLAN F6): every user rejection becomes a case (approval
// denied, consolidator proposal dismissed, Central plan rejected, rewind). The human reviews them here,
// LangSmith-style: Promote to golden (replayed by `webterm eval run`), Dismiss, or Export JSON.
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ActionButton, ActionResult, errorCause, useAction } from '@/components/ui/action'
import { Segmented } from '../centralSettings.controls'

export const EVAL_CASES_PATH = '/api/evalcases'
const PAGE = 50

export type EvalStatus = 'new' | 'promoted' | 'dismissed'
export interface EvalCaseView {
  id: string
  source: 'approval' | 'central_plan' | 'memory_proposal' | 'rewind'
  contextRef: string | null
  inputText: string | null
  proposed: { tool: string; summary: string }
  rejection: { by: string; how: string }
  reason: string | null
  status: EvalStatus
  rejectedAt: number
}

export const EVAL_TEXT = {
  title: 'Eval cases',
  intro: 'Saved examples used to test agent behaviour. Each time you turn something down (an approval, a memory suggestion, a Central Agent plan, a rewind) it is saved here with its context, with secrets and personal data removed. Mark a case as golden and `webterm eval run` replays it to catch regressions.',
  show: 'Show',
  loading: 'Loading eval cases…',
  loadFailed: 'Cannot load eval cases.',
  empty: 'No cases here.',
  status: { new: 'New', promoted: 'Golden', dismissed: 'Dismissed' } as Record<EvalStatus, string>,
  source: { approval: 'Approval denied', central_plan: 'Central plan rejected', memory_proposal: 'Memory proposal dismissed', rewind: 'Rewind' } as Record<EvalCaseView['source'], string>,
  reason: 'Why did you reject it? (optional)',
  promote: 'Promote to golden', dismiss: 'Dismiss', exportJson: 'Export JSON',
  promoting: 'Promoting…', dismissing: 'Dismissing…', exporting: 'Exporting…', exported: 'Downloaded webterm-eval-cases.json',
  shown: (n: number, total: number) => `Showing ${n} of ${total}`,
  rejectedBy: (by: string, at: number) => `rejected by ${by}, ${new Date(at).toLocaleString()}`,
  failed: (what: string, why: string) => `${what} failed: ${why}`,
}

async function request(method: string, path: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const out: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new Error((out as { error?: string } | null)?.error ?? `${method} ${path} -> ${res.status}`)
  return out
}

function download(name: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

/** One new-or-reviewed case; Promote / Dismiss each show busy, then the failure with Retry (a success reloads the list). */
function CaseRow({ c, reason, setReason, done }: { c: EvalCaseView; reason: string; setReason(v: string): void; done(): void }): React.JSX.Element {
  const decide = (action: 'promote' | 'dismiss') => async (): Promise<void> => {
    const why = reason.trim()
    await request('POST', `${EVAL_CASES_PATH}/${encodeURIComponent(c.id)}/${action}`, why ? { reason: why } : {})
    done()
  }
  const promote = useAction(decide('promote'), { label: EVAL_TEXT.promote, failure: (e) => EVAL_TEXT.failed(EVAL_TEXT.promote, errorCause(e)) })
  const dismiss = useAction(decide('dismiss'), { label: EVAL_TEXT.dismiss, failure: (e) => EVAL_TEXT.failed(EVAL_TEXT.dismiss, errorCause(e)) })
  const busy = promote.busy || dismiss.busy
  return (
    <li data-case={c.id} className="flex flex-col gap-1">
      <div><strong>{EVAL_TEXT.source[c.source]}</strong>: {c.proposed.summary}</div>
      <div className="opacity-70">{EVAL_TEXT.rejectedBy(c.rejection.by, c.rejectedAt)}{c.contextRef ? ` · ${c.contextRef}` : ''}</div>
      {c.inputText ? <blockquote className="line-clamp-3 opacity-80">{c.inputText}</blockquote> : null}
      {c.reason ? <div>{c.reason}</div> : null}
      {c.status === 'new' ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input aria-label={EVAL_TEXT.reason} placeholder={EVAL_TEXT.reason} value={reason} className="min-w-32 flex-1"
            onChange={(e) => setReason(e.target.value)} />
          <ActionButton size="sm" action={promote} busyLabel={EVAL_TEXT.promoting} disabled={busy}>{EVAL_TEXT.promote}</ActionButton>
          <ActionButton size="sm" variant="secondary" action={dismiss} busyLabel={EVAL_TEXT.dismissing} disabled={busy}>{EVAL_TEXT.dismiss}</ActionButton>
        </div>
      ) : null}
      <ActionResult action={promote} />
      <ActionResult action={dismiss} />
    </li>
  )
}

export function EvalCasesPanel(): React.JSX.Element {
  const [status, setStatus] = useState<EvalStatus>('new')
  const [page, setPage] = useState<{ cases: EvalCaseView[]; total: number } | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [reasons, setReasons] = useState<Record<string, string>>({})

  const load = useCallback(() => {
    request('GET', `${EVAL_CASES_PATH}?status=${status}&limit=${PAGE}`)
      .then((v) => { setPage(v as { cases: EvalCaseView[]; total: number }); setLoadError(false) })
      .catch(() => setLoadError(true)) // shown as the loadFailed note
  }, [status])
  useEffect(load, [load])

  const exportJson = useAction(async () => { download('webterm-eval-cases.json', await request('GET', `${EVAL_CASES_PATH}/export`)) }, {
    label: EVAL_TEXT.exportJson, success: () => EVAL_TEXT.exported, failure: (e) => EVAL_TEXT.failed(EVAL_TEXT.exportJson, errorCause(e)),
  })

  return (
    <section aria-label={EVAL_TEXT.title} data-testid="eval-cases-panel">
      <h3 className="font-semibold">{EVAL_TEXT.title}</h3>
      <p className="text-xs opacity-70">{EVAL_TEXT.intro}</p>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
        <Segmented label={EVAL_TEXT.show} value={status} onChange={(v) => setStatus(v as EvalStatus)}
          options={(Object.keys(EVAL_TEXT.status) as EvalStatus[]).map((s) => ({ value: s, label: EVAL_TEXT.status[s] }))} />
        <ActionButton size="sm" variant="secondary" action={exportJson} busyLabel={EVAL_TEXT.exporting}>{EVAL_TEXT.exportJson}</ActionButton>
      </div>
      <ActionResult action={exportJson} />
      {loadError ? <p className="text-xs opacity-70">{EVAL_TEXT.loadFailed}</p> : null}
      {!page && !loadError ? <p role="status" className="text-xs opacity-70">{EVAL_TEXT.loading}</p> : null}
      {page?.cases.length === 0 ? <p className="text-xs opacity-70">{EVAL_TEXT.empty}</p> : null}
      {page && page.cases.length > 0 ? (
        <ul className="mt-1 flex flex-col gap-2 text-xs" aria-label={EVAL_TEXT.title}>
          {page.cases.map((c) => (
            <CaseRow key={c.id} c={c} reason={reasons[c.id] ?? ''} done={load}
              setReason={(v) => setReasons((r) => ({ ...r, [c.id]: v }))} />
          ))}
        </ul>
      ) : null}
      {page && page.total > page.cases.length ? <p className="text-xs opacity-70">{EVAL_TEXT.shown(page.cases.length, page.total)}</p> : null}
    </section>
  )
}
