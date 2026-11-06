// Eval cases section of Settings › Control (PLAN F6): every user rejection becomes a case (approval
// denied, consolidator proposal dismissed, Central plan rejected, rewind). The human reviews them here,
// LangSmith-style: Promote to golden (replayed by `webterm eval run`), Dismiss, or Export JSON.
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

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
  intro: 'Each time you reject something (an approval, a memory proposal, a Central plan, a rewind) it is saved here with its context, scrubbed of secrets and personal data. Promote a case to the golden set and `webterm eval run` replays it against Central to catch regressions.',
  loading: 'Loading eval cases…',
  loadFailed: 'Cannot load eval cases.',
  empty: 'No cases here.',
  status: { new: 'New', promoted: 'Golden', dismissed: 'Dismissed' } as Record<EvalStatus, string>,
  source: { approval: 'Approval denied', central_plan: 'Central plan rejected', memory_proposal: 'Memory proposal dismissed', rewind: 'Rewind' } as Record<EvalCaseView['source'], string>,
  reason: 'Why did you reject it? (optional)',
  promote: 'Promote to golden', dismiss: 'Dismiss', exportJson: 'Export JSON',
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

export function EvalCasesPanel(): React.JSX.Element {
  const [status, setStatus] = useState<EvalStatus>('new')
  const [page, setPage] = useState<{ cases: EvalCaseView[]; total: number } | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reasons, setReasons] = useState<Record<string, string>>({})

  const load = useCallback(() => {
    request('GET', `${EVAL_CASES_PATH}?status=${status}&limit=${PAGE}`)
      .then((v) => { setPage(v as { cases: EvalCaseView[]; total: number }); setLoadError(false) })
      .catch(() => setLoadError(true)) // shown as the loadFailed note
  }, [status])
  useEffect(load, [load])

  const decide = async (id: string, action: 'promote' | 'dismiss'): Promise<void> => {
    setError(null)
    try {
      const reason = reasons[id]?.trim()
      await request('POST', `${EVAL_CASES_PATH}/${encodeURIComponent(id)}/${action}`, reason ? { reason } : {})
      load()
    } catch (err) { setError(EVAL_TEXT.failed(action === 'promote' ? EVAL_TEXT.promote : EVAL_TEXT.dismiss, err instanceof Error ? err.message : String(err))) }
  }

  const exportJson = async (): Promise<void> => {
    setError(null)
    try { download('webterm-eval-cases.json', await request('GET', `${EVAL_CASES_PATH}/export`)) } catch (err) {
      setError(EVAL_TEXT.failed(EVAL_TEXT.exportJson, err instanceof Error ? err.message : String(err)))
    }
  }

  return (
    <section aria-label={EVAL_TEXT.title} data-testid="eval-cases-panel">
      <h3 className="font-semibold">{EVAL_TEXT.title}</h3>
      <p className="text-xs opacity-70">{EVAL_TEXT.intro}</p>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs" role="group" aria-label="Status">
        {(Object.keys(EVAL_TEXT.status) as EvalStatus[]).map((s) => (
          <Button key={s} size="sm" variant={s === status ? 'default' : 'secondary'} aria-pressed={s === status} onClick={() => setStatus(s)}>{EVAL_TEXT.status[s]}</Button>
        ))}
        <Button size="sm" variant="secondary" onClick={() => void exportJson()}>{EVAL_TEXT.exportJson}</Button>
      </div>
      {loadError ? <p className="text-xs opacity-70">{EVAL_TEXT.loadFailed}</p> : null}
      {!page && !loadError ? <p role="status" className="text-xs opacity-70">{EVAL_TEXT.loading}</p> : null}
      {page?.cases.length === 0 ? <p className="text-xs opacity-70">{EVAL_TEXT.empty}</p> : null}
      {page && page.cases.length > 0 ? (
        <ul className="mt-1 flex flex-col gap-2 text-xs" aria-label={EVAL_TEXT.title}>
          {page.cases.map((c) => (
            <li key={c.id} data-case={c.id} className="flex flex-col gap-1">
              <div><strong>{EVAL_TEXT.source[c.source]}</strong>: {c.proposed.summary}</div>
              <div className="opacity-70">{EVAL_TEXT.rejectedBy(c.rejection.by, c.rejectedAt)}{c.contextRef ? ` · ${c.contextRef}` : ''}</div>
              {c.inputText ? <blockquote className="line-clamp-3 opacity-80">{c.inputText}</blockquote> : null}
              {c.reason ? <div>{c.reason}</div> : null}
              {c.status === 'new' ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Input aria-label={EVAL_TEXT.reason} placeholder={EVAL_TEXT.reason} value={reasons[c.id] ?? ''} className="min-w-32 flex-1"
                    onChange={(e) => setReasons((r) => ({ ...r, [c.id]: e.target.value }))} />
                  <Button size="sm" onClick={() => void decide(c.id, 'promote')}>{EVAL_TEXT.promote}</Button>
                  <Button size="sm" variant="secondary" onClick={() => void decide(c.id, 'dismiss')}>{EVAL_TEXT.dismiss}</Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {page && page.total > page.cases.length ? <p className="text-xs opacity-70">{EVAL_TEXT.shown(page.cases.length, page.total)}</p> : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </section>
  )
}
