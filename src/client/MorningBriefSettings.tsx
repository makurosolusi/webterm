// Switch for the optional LLM paragraph of the morning brief (F5-c; off by default). The deterministic lines
// are always shown; this only adds a model-phrased summary that the server checks against their counts.
// Self-loading so Settings › Control can mount it as is; the brief card passes its known state instead.
import { useEffect, useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import type { BriefResponse } from '../server/brief/brief.service'
import { request } from './inboxTransport'

export const BRIEF_LLM_PATH = '/api/brief/llm'

export interface MorningBriefLlmToggleProps {
  /** Known state (the brief card); undefined = read it from `/api/brief`. */
  on?: boolean
  onChange?: (brief: BriefResponse) => void
}

export function MorningBriefLlmToggle({ on, onChange }: MorningBriefLlmToggleProps): React.JSX.Element {
  const [value, setValue] = useState<boolean | undefined>(on)
  const [error, setError] = useState('')
  useEffect(() => { if (on !== undefined) setValue(on) }, [on])
  useEffect(() => {
    if (on !== undefined) return
    // Unreadable (ledger off / offline): the switch stays disabled; only a failed write is shown as an error.
    request<BriefResponse>('/api/brief').then((b) => setValue(b.llm), (err: unknown) => console.warn('[brief] GET /api/brief failed', err))
  }, [on])

  const toggle = (next: boolean): void => {
    setValue(next)
    request<BriefResponse>(`${BRIEF_LLM_PATH}/${next ? 'on' : 'off'}`, { method: 'POST' }).then((b) => { setError(''); onChange?.(b) }, (err: unknown) => {
      setValue(!next)
      setError(err instanceof Error ? err.message : String(err))
    })
  }

  return (
    <label className="morning-brief__llm">
      <Checkbox checked={value === true} disabled={value === undefined} onCheckedChange={(c) => toggle(c === true)} aria-label="AI summary in the morning brief" />
      <span>AI summary in the morning brief</span>
      {error && <span className="morning-brief__error" role="alert">{error}</span>}
    </label>
  )
}
