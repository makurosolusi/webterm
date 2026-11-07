// Session replay dialog (F6), opened from ⌘K ("Replay Session…"). One scrubbable timeline with a lane
// per source; moving the playhead shows the state at that moment (transcript so far, the checkpoint
// diff, cost so far, live scrollback at the end) and offers "Rewind to here".
//
// Imitated designs: rrweb-player / Replay.io (a progress bar you drag; seeking replays every event up
// to t), Langfuse / LangSmith trace timelines (cost on the same rows as turns and tool calls), Claude
// Code `/rewind` (a moment maps to a code checkpoint). Rewind is the Activity timeline's own
// `RewindControl` over /api/checkpoints: preview, confirm, restore with an undo checkpoint.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { RewindControl } from '../Timeline.checkpoint'
import '../Timeline.css'
import {
  LANES, REPLAY_TEXT as T, byLane, fetchReplayPage, fetchReplayState, formatUsd, pct, rangeFrom, stateAt,
  type RangeKey, type ReplayItem, type ReplayStateView,
} from './replay.client'

export interface ReplayNode { id: string; title?: string }
const STATE_DEBOUNCE_MS = 150
const time = (ts: number): string => new Date(ts).toLocaleTimeString()

export function ReplayDialog({ workspaceId, nodes, onClose, now = Date.now }: { workspaceId: string; nodes: readonly ReplayNode[]; onClose: () => void; now?: () => number }): React.JSX.Element {
  const [nodeId, setNodeId] = useState<string | null>(null)
  const [range, setRange] = useState<RangeKey>('day')
  const from = useMemo(() => rangeFrom(range, now()), [range, now])
  const [items, setItems] = useState<ReplayItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [t, setT] = useState(0)
  const [view, setView] = useState<ReplayStateView | null>(null)
  const query = useMemo(() => ({ workspaceId, nodeId, from }), [workspaceId, nodeId, from])
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e))

  const load = useCallback((after: string | null) => {
    setBusy(true); setError(null)
    fetchReplayPage(query, after).then((p) => {
      setItems((prev) => (after ? [...prev, ...p.items] : p.items))
      if (p.items.length || !after) setT(p.items.at(-1)?.ts ?? 0)
      setCursor(p.nextCursor)
    }, fail).finally(() => setBusy(false))
  }, [query])
  useEffect(() => load(null), [load])

  const min = items[0]?.ts ?? 0
  const max = items.at(-1)?.ts ?? 0
  const atEnd = items.length > 0 && t >= max && cursor === null
  useEffect(() => {
    if (items.length === 0) { setView(null); return }
    const id = setTimeout(() => { fetchReplayState(query, atEnd ? now() : t).then(setView, fail) }, STATE_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [query, t, atEnd, items.length, now])

  const scrub = useMemo(() => stateAt(items, t), [items, t])
  const lanes = useMemo(() => byLane(items), [items])
  const cp = view?.checkpoint ?? null

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl" data-testid="replay-dialog">
        <DialogHeader>
          <DialogTitle>{T.title}</DialogTitle>
          <DialogDescription>{T.intro}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-1 text-xs" role="group" aria-label={T.scope}>
          {[{ id: null as string | null, title: T.workspace }, ...nodes].map((n) => (
            <Button key={n.id ?? ''} size="sm" variant={nodeId === n.id ? 'default' : 'outline'} aria-pressed={nodeId === n.id} onClick={() => setNodeId(n.id)}>{n.title || n.id}</Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1 text-xs" role="group" aria-label={T.range}>
          {(Object.keys(T.ranges) as RangeKey[]).map((k) => (
            <Button key={k} size="sm" variant={range === k ? 'default' : 'outline'} aria-pressed={range === k} onClick={() => setRange(k)}>{T.ranges[k]}</Button>
          ))}
        </div>
        {error && <p className="text-xs text-red-600" role="alert">{error}</p>}
        {items.length === 0 ? <p className="text-xs opacity-70">{busy ? T.loading : T.empty}</p> : (
          <>
            <div className="flex flex-col gap-1" data-testid="replay-lanes">
              {LANES.map((lane) => (
                <div key={lane} className="flex items-center gap-2 text-xs">
                  <span className="w-28 shrink-0 opacity-80">{T.lanes[lane]} ({scrub.counts[lane]}/{lanes[lane].length})</span>
                  <div className="relative h-4 flex-1 rounded bg-black/10" aria-label={T.lanes[lane]}>
                    {lanes[lane].map((i) => (
                      <span key={i.key} title={`${time(i.ts)} · ${i.text}`} data-testid={`replay-tick-${i.key}`} onClick={() => setT(i.ts)}
                        className={`absolute top-0 h-4 w-1 cursor-pointer ${i.ts <= t ? 'bg-blue-500' : 'bg-gray-400'} ${scrub.current?.key === i.key ? 'outline outline-1' : ''}`}
                        style={{ left: `${pct(i.ts, min, max)}%` }} />
                    ))}
                    <span className="pointer-events-none absolute top-0 h-4 w-px bg-red-500" style={{ left: `${pct(t, min, max)}%` }} />
                  </div>
                </div>
              ))}
              <Input type="range" aria-label={T.scrub} min={min} max={max} step={1} value={t} onChange={(e) => setT(Number(e.target.value))} />
              <p className="text-xs" data-testid="replay-playhead">{time(t)}{scrub.current ? ` · ${T.lanes[scrub.current.lane]}: ${scrub.current.text}` : ''}</p>
              {cursor && <Button size="sm" variant="outline" disabled={busy} onClick={() => load(cursor)}>{busy ? T.loading : T.loadMore}</Button>}
            </div>
            <section className="grid gap-2 text-xs sm:grid-cols-2">
              <div>
                <h4 className="font-semibold">{T.transcriptAt}</h4>
                {view && view.transcript.length > 0
                  ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap" data-testid="replay-transcript">{view.transcript.map((l) => l.text).join('\n')}</pre>
                  : <p className="opacity-70">{T.noTranscript}</p>}
                <p>{T.costAt(formatUsd(view?.costMicros ?? 0))}</p>
              </div>
              <div>
                {cp ? (
                  <>
                    <h4 className="font-semibold">{T.checkpointAt(cp.seq, cp.baseSeq)}</h4>
                    {cp.files.length === 0 ? <p className="opacity-70">{T.noChanges}</p> : <ul>{cp.files.map((f) => <li key={f.path}>{f.status} {f.path}</li>)}</ul>}
                    {cp.patch && <pre className="max-h-48 overflow-auto whitespace-pre" data-testid="replay-diff">{cp.patch}{cp.truncated ? `\n${T.truncated}` : ''}</pre>}
                    <div className="mt-1" aria-label={T.rewindHere}><RewindControl workspaceId={workspaceId} seq={cp.seq} /></div>
                  </>
                ) : <p className="opacity-70">{T.noCheckpoint}</p>}
              </div>
            </section>
            {nodeId && (
              <section className="text-xs">
                <h4 className="font-semibold">{T.terminal}</h4>
                {view?.scrollback ? <pre className="max-h-48 overflow-auto whitespace-pre" data-testid="replay-scrollback">{view.scrollback.text}</pre> : <p className="opacity-70">{T.noTerminal}</p>}
              </section>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
