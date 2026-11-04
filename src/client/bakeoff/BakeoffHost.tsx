// Bake-off dialog (F6), opened from ⌘K ("Bake-off: Compare Agents on One Prompt…"). Start a fan-out,
// watch the candidate cards fill in (diff stat, verifier result, cost, duration), pick a winner, merge
// it, and only then clean up the other worktrees behind an explicit confirm. Imitates Cursor Best-of-N:
// the tool compares, the human chooses, applying is a separate step.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { useRegisterCommands } from '../commandRegistry'
import { BAKEOFF_API, BAKEOFF_POLL_MS, BAKEOFF_TEXT as T, bakeoffRequest, formatCost, formatDuration, verdictLine, type BakeoffView, type CandidateView } from './bakeoff.client'

const COUNTS = [2, 3, 4] as const

function CandidateCard({ b, c, busy, onPick }: { b: BakeoffView; c: CandidateView; busy: boolean; onPick: (id: string) => void }): React.JSX.Element {
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
      {canPick && <Button size="sm" className="mt-1" disabled={busy} onClick={() => onPick(c.id)}>{T.pick}</Button>}
    </li>
  )
}

export function BakeoffDialog({ repo, workspaceId, onClose }: { repo?: string; workspaceId?: string | null; onClose: () => void }): React.JSX.Element {
  const [list, setList] = useState<BakeoffView[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [count, setCount] = useState<number>(2)
  const [busy, setBusy] = useState(false)
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

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null)
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false); load() }
  }
  const start = () => act(async () => {
    const b = (await bakeoffRequest('POST', BAKEOFF_API, { repo, prompt, count, workspaceId: workspaceId ?? null })) as BakeoffView
    setSelected(b.id); setPrompt('')
  })
  const path = (verb: string) => `${BAKEOFF_API}/${encodeURIComponent(current!.id)}/${verb}`
  const pick = (candidateId: string) => act(() => bakeoffRequest('POST', path('pick'), { candidateId }))
  const merge = () => act(() => bakeoffRequest('POST', path('merge'), {}))
  const askCleanup = () => act(async () => {
    const r = (await bakeoffRequest('POST', path('cleanup'), {}, [409])) as { error?: string; remove?: CandidateView[] }
    setConfirm(r.remove ?? [])
  })
  const doCleanup = () => act(async () => { await bakeoffRequest('POST', path('cleanup'), { confirm: true }); setConfirm(null) })

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
              <Button size="sm" disabled={busy || prompt.trim() === ''} onClick={() => void start()}>{busy ? T.starting : T.start}</Button>
            </div>
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
              {current.candidates.map((c) => <CandidateCard key={c.id} b={current} c={c} busy={busy} onPick={(id) => void pick(id)} />)}
            </ul>
            <div className="flex flex-wrap gap-2">
              {current.status === 'picked' && <Button size="sm" disabled={busy} onClick={() => void merge()}>{T.merge(current.baseBranch)}</Button>}
              {(current.status === 'picked' || current.status === 'merged') && !confirm && <Button size="sm" variant="outline" disabled={busy} onClick={() => void askCleanup()}>{T.cleanup}</Button>}
            </div>
            {confirm && (
              <div className="rounded border p-2 text-xs" role="alertdialog" aria-label={T.cleanup}>
                <p>{T.confirmCleanup(confirm.length)}</p>
                <ul>{confirm.map((c) => <li key={c.id}>#{c.idx} {c.branch}</li>)}</ul>
                <div className="mt-1 flex gap-2">
                  <Button size="sm" variant="destructive" disabled={busy} onClick={() => void doCleanup()}>{T.confirm}</Button>
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

/** Registers the ⌘K command and owns the dialog's open state; mounted once in App. */
export default function BakeoffHost({ repo, workspaceId }: { repo?: string; workspaceId?: string | null }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const commands = useMemo(() => [{ id: 'bakeoff.open', label: T.command, run: () => setOpen(true) }], [])
  useRegisterCommands(commands)
  return open ? <BakeoffDialog repo={repo} workspaceId={workspaceId} onClose={() => setOpen(false)} /> : null
}
