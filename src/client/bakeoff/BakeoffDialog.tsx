// Bake-off dialog (F6), opened from ⌘K ("Bake-off: Compare Agents on One Prompt…"). Start a fan-out,
// watch the candidate cards fill in (diff stat, verifier result, cost, duration), pick a winner, merge
// it, and only then clean up the other worktrees behind an explicit confirm. Imitates Cursor Best-of-N:
// the tool compares, the human chooses, applying is a separate step.
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ActionButton, ActionResult, useAction } from '@/components/ui/action'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { BAKEOFF_API, BAKEOFF_POLL_MS, BAKEOFF_TEXT as T, bakeoffRequest, formatCost, formatDuration, verdictLine, type BakeoffView, type CandidateView } from './bakeoff.client'

const COUNTS = [2, 3, 4] as const
const LABEL = { picking: 'Picking…', merging: 'Merging…', checking: 'Checking…', removing: 'Removing…', started: 'Started', confirmBelow: 'Confirm the removal below' } as const

function CandidateCard({ b, c, busy, onPick }: { b: BakeoffView; c: CandidateView; busy: boolean; onPick: (id: string) => Promise<unknown> }): React.JSX.Element {
  const pick = useAction(() => onPick(c.id), { label: `${T.pick} #${c.idx}`, success: () => T.winner })
  const isWinner = b.winnerId === c.id
  const canPick = (b.status === 'ready' || b.status === 'picked') && c.status !== 'removed' && !isWinner
  return (
    <li className={`rounded border p-2 text-xs ${isWinner ? 'border-green-600' : ''}`} data-testid={`bakeoff-candidate-${c.idx}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">#{c.idx} <span className="font-normal opacity-70">{c.branch}</span></span>
        {isWinner ? <Badge>{T.winner}</Badge> : c.status === 'done' ? <Badge variant={c.verified ? 'default' : 'secondary'}>{c.verified ? T.verified : T.unverified}</Badge> : <Badge variant="secondary">{c.status}</Badge>}
      </div>
      <p>{verdictLine(c)} · {formatCost(c.costMicros)}{c.durationMs !== null ? ` · ${formatDuration(c.durationMs)}` : ''}</p>
      {c.error && <p className="text-red-600">{c.error}</p>}
      {c.verdict?.diffStat ? <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap opacity-80">{c.verdict.diffStat}</pre> : null}
      {canPick && <ActionButton size="sm" className="mt-1" disabled={busy} action={pick} busyLabel={LABEL.picking}>{T.pick}</ActionButton>}
      <ActionResult action={pick} />
    </li>
  )
}

export function BakeoffDialog({ repo, workspaceId, onClose }: { repo?: string; workspaceId?: string | null; onClose: () => void }): React.JSX.Element {
  const [list, setList] = useState<BakeoffView[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [count, setCount] = useState<number>(2)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<CandidateView[] | null>(null)

  const load = useCallback(() => {
    bakeoffRequest('GET').then((v) => {
      const items = (v as { bakeoffs?: BakeoffView[] } | null)?.bakeoffs ?? []
      setList(items)
      setSelected((s) => s ?? items[0]?.id ?? null)
    }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [])
  useEffect(load, [load])
  const current = list.find((b) => b.id === selected) ?? null
  const running = list.some((b) => b.status === 'running')
  useEffect(() => {
    if (!running) return
    const t = setInterval(load, BAKEOFF_POLL_MS)
    return () => clearInterval(t)
  }, [running, load])

  /** Every action reloads the list afterwards, whatever its outcome. */
  const reloadAfter = <R,>(fn: () => Promise<R>) => async (): Promise<R> => { try { return await fn() } finally { load() } }
  const path = (verb: string) => `${BAKEOFF_API}/${encodeURIComponent(current!.id)}/${verb}`
  const start = useAction(reloadAfter(async () => {
    const b = (await bakeoffRequest('POST', BAKEOFF_API, { repo, prompt, count, workspaceId: workspaceId ?? null })) as BakeoffView
    setSelected(b.id); setPrompt('')
  }), { label: T.start, success: () => LABEL.started })
  const pick = (candidateId: string) => reloadAfter(() => bakeoffRequest('POST', path('pick'), { candidateId }))()
  const merge = useAction(reloadAfter(() => bakeoffRequest('POST', path('merge'), {})), { label: T.merge(current?.baseBranch ?? ''), success: () => T.status.merged })
  const askCleanup = useAction(reloadAfter(async () => {
    const r = (await bakeoffRequest('POST', path('cleanup'), {}, [409])) as { error?: string; remove?: CandidateView[] }
    setConfirm(r.remove ?? [])
  }), { label: T.cleanup, success: () => LABEL.confirmBelow })
  const doCleanup = useAction(reloadAfter(async () => { await bakeoffRequest('POST', path('cleanup'), { confirm: true }); setConfirm(null) }),
    { label: T.confirm, success: () => T.status.cleaned })
  const busy = start.busy || merge.busy || askCleanup.busy || doCleanup.busy

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl" data-testid="bakeoff-dialog">
        <DialogHeader>
          <DialogTitle>{T.title}</DialogTitle>
          <DialogDescription>{T.intro}</DialogDescription>
        </DialogHeader>
        {!repo ? <p className="text-xs">{T.noRepo}</p> : (
          <div className="flex flex-col gap-2">
            <label className="text-xs font-semibold" htmlFor="bakeoff-prompt">{T.prompt}</label>
            <Textarea id="bakeoff-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} />
            <div className="flex items-center gap-2 text-xs">
              <span id="bakeoff-count">{T.count}</span>
              <div role="group" aria-labelledby="bakeoff-count" className="flex gap-1">
                {COUNTS.map((n) => (
                  <Button key={n} size="sm" variant={count === n ? 'default' : 'outline'} aria-pressed={count === n} onClick={() => setCount(n)}>{n}</Button>
                ))}
              </div>
              <ActionButton size="sm" disabled={busy || prompt.trim() === ''} action={start} busyLabel={T.starting}>{T.start}</ActionButton>
            </div>
            <ActionResult action={start} />
          </div>
        )}
        {error && <p className="text-xs text-red-600" role="alert">{error}</p>}
        <h4 className="text-xs font-semibold">{T.recent}</h4>
        {list.length === 0 ? <p className="text-xs opacity-70">{T.none}</p> : (
          <div role="group" aria-label={T.recent} className="flex flex-wrap gap-1">
            {list.map((b) => (
              <Button key={b.id} size="sm" variant={b.id === selected ? 'default' : 'outline'} aria-pressed={b.id === selected} onClick={() => { setSelected(b.id); setConfirm(null) }}>
                {`${T.status[b.status]} · ${b.prompt.slice(0, 60)}`}
              </Button>
            ))}
          </div>
        )}
        {current && (
          <div className="flex flex-col gap-2">
            <p className="text-xs opacity-80">{current.prompt}</p>
            <ul className="grid gap-2 sm:grid-cols-2">
              {current.candidates.map((c) => <CandidateCard key={c.id} b={current} c={c} busy={busy} onPick={pick} />)}
            </ul>
            <div className="flex flex-wrap gap-2">
              {current.status === 'picked' && <ActionButton size="sm" disabled={busy} action={merge} busyLabel={LABEL.merging}>{T.merge(current.baseBranch)}</ActionButton>}
              {(current.status === 'picked' || current.status === 'merged') && !confirm && <ActionButton size="sm" variant="outline" disabled={busy} action={askCleanup} busyLabel={LABEL.checking}>{T.cleanup}</ActionButton>}
            </div>
            <ActionResult action={merge} />
            <ActionResult action={askCleanup} />
            <ActionResult action={doCleanup} />
            {confirm && (
              <div className="rounded border p-2 text-xs" role="alertdialog" aria-label={T.cleanup}>
                <p>{T.confirmCleanup(confirm.length)}</p>
                <ul>{confirm.map((c) => <li key={c.id}>#{c.idx} {c.branch}</li>)}</ul>
                <div className="mt-1 flex gap-2">
                  <ActionButton size="sm" variant="destructive" disabled={busy} action={doCleanup} busyLabel={LABEL.removing}>{T.confirm}</ActionButton>
                  <Button size="sm" variant="outline" onClick={() => setConfirm(null)}>{T.cancel}</Button>
                </div>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
