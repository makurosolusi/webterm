// Settings › Health: is everything working on this machine. The demo-mode banner (a simulated runtime), the
// agent protection summary in plain lines, and the Doctor checks with their one-click fixes.
import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { AGENT_PROTECTION_PATH, controlRequest, getJson, isConfig, isProtection, type AgentProtection } from './ControlPanel'
import { ControlPanelDoctor } from './ControlPanelDoctor'
import { CONTROL_TEXT, HEALTH_TEXT } from './controlPanelLabels'

/** One line when every agent is protected, else one line per agent that is only partly protected. */
function protectionLines(list: readonly AgentProtection[]): string[] {
  const partly = list.filter((p) => p.level !== 'protected')
  return partly.length === 0 ? [HEALTH_TEXT.allProtected] : partly.map((p) => HEALTH_TEXT.partly(p.kind, p.reasons.join('; ')))
}

/** Health section body. */
export function HealthSection(): React.JSX.Element {
  const [mockKeys, setMockKeys] = useState<string[]>([])
  // undefined = loading, null = endpoint absent or unreadable (rendered as "not available yet").
  const [protection, setProtection] = useState<AgentProtection[] | null | undefined>(undefined)

  useEffect(() => {
    let live = true
    controlRequest('GET')
      .then((v) => { if (live && isConfig(v) && v.mock.active) setMockKeys(v.mock.keys) })
      .catch(() => { if (live) setMockKeys([]) }) // no banner without a positive answer; Settings › Developer reports the load failure
    getJson(AGENT_PROTECTION_PATH)
      .then((v) => { if (live) setProtection(isProtection(v) ? v : null) })
      .catch(() => { if (live) setProtection(null) }) // degrade to "not available yet", do not fail the page
    return () => { live = false }
  }, [])

  return (
    <div className="flex flex-col gap-3 text-[13px]" data-testid="health-section">
      {mockKeys.length > 0 ? (
        <p role="alert" title={mockKeys.join(', ')} className="flex items-center gap-2">
          <Badge variant="destructive" className="font-bold">{CONTROL_TEXT.mockBadge}</Badge>
          <span>{HEALTH_TEXT.mock}</span>
        </p>
      ) : null}
      <section aria-label={HEALTH_TEXT.protectionTitle}>
        <h3 className="font-semibold">{HEALTH_TEXT.protectionTitle}</h3>
        {protection === null ? <p className="text-xs opacity-70">{HEALTH_TEXT.protectionMissing}</p> : null}
        {protection ? (
          <ul className="text-xs">{protectionLines(protection).map((line) => <li key={line}>{line}</li>)}</ul>
        ) : null}
      </section>
      <ControlPanelDoctor />
    </div>
  )
}
