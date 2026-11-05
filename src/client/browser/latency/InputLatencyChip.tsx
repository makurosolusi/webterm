// Chip anggaran latensi input->frame (I1-d). Membaca jendela tiap LATENCY_POLL_MS (bukan per frame), jadi
// menggambar frame tak pernah memicu render React. Tersembunyi saat idle; klik = rincian per tahap.
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-button'
import { clientNow, LATENCY_BUDGET_MS, LATENCY_STAGES, summarize } from './inputLatency.window'
import type { LatencyStage, LatencySummary, LatencyTone, LatencyWindow } from './inputLatency.window'

const LATENCY_POLL_MS = 500

export const STAGE_LABEL: Record<LatencyStage, string> = {
  network: 'Network (send + return)',
  rxToDispatch: 'Server receive → CDP dispatch',
  dispatchToSwap: 'CDP dispatch → frame swap',
  swapToServer: 'Frame swap → server',
  clientPaint: 'Client receive → paint',
}

const TONE_CLASS: Record<LatencyTone, string> = {
  good: 'text-(--vscode-testing-iconPassed)',
  warn: 'text-(--vscode-editorWarning-foreground)',
  bad: 'text-(--vscode-editorError-foreground)',
}

const ms = (v: number) => `${Math.round(v)} ms`

export default function InputLatencyChip({ window: w, now = clientNow }: { window: LatencyWindow; now?: () => number }) {
  const [sum, setSum] = useState<LatencySummary | null>(() => summarize(w, now()))
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const t = setInterval(() => setSum(summarize(w, now())), LATENCY_POLL_MS)
    return () => clearInterval(t)
  }, [w, now])
  if (!sum) return null
  return (
    <div className="nodrag absolute bottom-2 right-2 z-10 flex flex-col items-end gap-1 text-xs">
      {open && (
        <dl
          aria-label="Input latency breakdown"
          className="grid grid-cols-[auto_auto] gap-x-3 rounded px-2 py-1 bg-(--vscode-editorWidget-background) text-(--vscode-foreground) border border-(--vscode-editorWidget-border)"
        >
          {LATENCY_STAGES.map((s) => (
            <div key={s} className="contents">
              <dt>{STAGE_LABEL[s]}</dt>
              <dd className="text-right tabular-nums">{ms(sum.stages[s])}</dd>
            </div>
          ))}
          <dt className="col-span-2 opacity-70">p50 per stage, last {sum.count} inputs</dt>
        </dl>
      )}
      <IconTooltip
        side="left"
        label={`Input to frame: p50 ${ms(sum.p50)}, p95 ${ms(sum.p95)} (budget ${LATENCY_BUDGET_MS.good}/${LATENCY_BUDGET_MS.warn} ms). Click to ${open ? 'hide' : 'show'} the per-stage breakdown`}
      >
        <Button
          size="xs"
          variant="outline"
          data-tone={sum.tone}
          aria-expanded={open}
          className={`tabular-nums ${TONE_CLASS[sum.tone]}`}
          onClick={() => setOpen((o) => !o)}
        >
          {ms(sum.p50)} · p95 {ms(sum.p95)}
        </Button>
      </IconTooltip>
    </div>
  )
}
