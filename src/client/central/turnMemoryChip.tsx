// Per-turn "what did Central use" chip in the reply footer. The list is fetched when the chip opens, never for
// each message, so the count is only known then (history carries no count).
import { useEffect, useRef, useState } from 'react'
import { Popover } from 'radix-ui'
import { portalContainer } from '@/components/vscode/portalContainer'
import { isAbortError } from '../inboxApi'
import { CL, TRUST_LABEL } from './centralLabels'
import { fetchTurnContext } from './centralControlApi'
import type { TurnContext } from './centralControlTypes'
import { centralErrorMessage } from './centralLoad'
import './central.css'

const versionText = (v: number | null): string => (v === null ? CL.turnStateNone : `v${v}`)

function Details({ context }: { context: TurnContext }) {
  if (context.headerChars === null) return <p>{CL.turnNotRecorded}</p>
  const versions = context.stateVersions
  return (
    <>
      {context.memory.length === 0 && <p>{CL.turnMemoryNone}</p>}
      {context.memory.length > 0 && (
        <ul>{context.memory.map((m) => <li key={m.id}>{m.title} <span className="ccp-row__meta">{TRUST_LABEL[m.trust] ?? m.trust}</span></li>)}</ul>
      )}
      <p>{CL.turnCheckpoint(context.checkpointId !== null)}</p>
      {versions && <p>{CL.turnStateVersions(versionText(versions.global), versionText(versions.project))}</p>}
    </>
  )
}

export function TurnMemoryChip({ turnId, load = fetchTurnContext }: { turnId: string; load?: typeof fetchTurnContext }) {
  const [context, setContext] = useState<TurnContext | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef<AbortController | null>(null)
  useEffect(() => () => inFlight.current?.abort(), [])

  const fetchOnce = (): void => {
    if (context || inFlight.current) return
    const ac = new AbortController()
    inFlight.current = ac
    setError(null)
    load(turnId, ac.signal).then(
      (result) => { inFlight.current = null; setContext(result) },
      (err: unknown) => { inFlight.current = null; if (!isAbortError(err)) setError(centralErrorMessage(err)) },
    )
  }

  const label = context && context.headerChars !== null ? CL.turnMemoryCount(context.memory.length) : CL.turnMemoryChip
  return (
    <Popover.Root onOpenChange={(open) => { if (open) fetchOnce() }}>
      <Popover.Trigger asChild>
        <button type="button" className="ccm-chip" aria-label={`${CL.turnMemoryChipLabel}: ${label}`}>{label}</button>
      </Popover.Trigger>
      <Popover.Portal container={portalContainer()}>
        <Popover.Content className="ccm-popover" side="top" align="end" sideOffset={4} aria-label={CL.turnMemoryChipLabel}>
          {error && <p role="alert" className="ccp-error">{error}</p>}
          {!error && !context && <p role="status">{CL.loading}</p>}
          {context && <Details context={context} />}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
