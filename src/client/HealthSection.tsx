// Settings › About this machine (id `health`): is everything working on this computer. Cards: the demo-mode
// banner (a simulated runtime), Checks (the Doctor with its one-click fixes and Copy diagnostics), Agent protection
// as status rows, the Data folder with Copy path, and Developer tools (the switch that shows Settings › Developer,
// ./developerMode). Machine diagnostics only: code health is the Control panel's Health tab.
import { useEffect, useState } from 'react'
import { ActionButton, ActionResult, useAction } from '@/components/ui/action'
import { Badge } from '@/components/ui/badge'
import { writeClipboard } from './clipboard'
import { AGENT_PROTECTION_PATH, controlRequest, getJson, isConfig, isProtection, type AgentProtection } from './ControlPanel'
import { ControlPanelDoctor, StatusBadge } from './ControlPanelDoctor'
import { CONTROL_TEXT, HEALTH_TEXT } from './controlPanelLabels'
import { useDeveloperMode, writeDeveloperMode } from './developerMode'
import { CardEmpty, CardError, CardLoading } from './SettingsCardState'
import { SettingsGroup } from './SettingsControls'
import { ToggleField } from './SettingsFields'
import { useCapabilities } from './useCapabilities'
import './settings-system.css'

/** One row when every agent is protected, else one row per agent that is only partly protected. */
function protectionLines(list: readonly AgentProtection[]): Array<{ ok: boolean; text: string }> {
  const partly = list.filter((p) => p.level !== 'protected')
  return partly.length === 0 ? [{ ok: true, text: HEALTH_TEXT.allProtected }] : partly.map((p) => ({ ok: false, text: HEALTH_TEXT.partly(p.kind, p.reasons.join('; ')) }))
}

function DataFolder({ dir, failed, onRetry }: { dir: string | undefined; failed: string | null; onRetry(): void }): React.JSX.Element {
  const copy = useAction(async () => {
    if (!dir || !(await writeClipboard(dir))) throw new Error(HEALTH_TEXT.copyRefused)
  }, { label: HEALTH_TEXT.copyPath, success: () => HEALTH_TEXT.copiedPath })
  return (
    <SettingsGroup title={HEALTH_TEXT.dataDir} description={HEALTH_TEXT.dataDirHint}>
      {dir ? (
        <div className="st-field">
          <div className="st-field-text">
            <code className="st-path" data-testid="data-dir">{dir}</code>
            <ActionResult action={copy} />
          </div>
          <div className="st-control"><ActionButton size="sm" variant="outline" action={copy} busyLabel={HEALTH_TEXT.copyPath}>{HEALTH_TEXT.copyPath}</ActionButton></div>
        </div>
      ) : failed ? <CardError text={failed} onRetry={onRetry} /> : <CardLoading text={HEALTH_TEXT.dataDirLoading} />}
    </SettingsGroup>
  )
}

/** About this machine section body. */
export function HealthSection(): React.JSX.Element {
  const [mockKeys, setMockKeys] = useState<string[]>([])
  // undefined = loading, null = endpoint absent or unreadable (rendered as "not available yet").
  const [protection, setProtection] = useState<AgentProtection[] | null | undefined>(undefined)
  const caps = useCapabilities()
  const dataDir = caps.data?.advanced.dataDir
  const developer = useDeveloperMode()

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

  const lines = protection ? protectionLines(protection) : []
  const extra = [
    ...(mockKeys.length > 0 ? [HEALTH_TEXT.mock] : []),
    ...lines.map((l) => `${HEALTH_TEXT.protectionTitle}: ${l.text}`),
    ...(dataDir ? [`${HEALTH_TEXT.dataDir}: ${dataDir}`] : []),
  ]

  return (
    <div className="flex flex-col" data-testid="health-section">
      {mockKeys.length > 0 ? (
        <p role="alert" className="st-state st-state--error">
          <Badge variant="destructive" className="font-bold">{CONTROL_TEXT.mockBadge}</Badge>
          <span>{HEALTH_TEXT.mock}</span>
        </p>
      ) : null}
      <ControlPanelDoctor extra={extra} />
      <SettingsGroup title={HEALTH_TEXT.protectionTitle} description={HEALTH_TEXT.protectionIntro}>
        {protection === undefined ? <CardLoading text={HEALTH_TEXT.protectionLoading} /> : null}
        {protection === null ? <CardEmpty text={HEALTH_TEXT.protectionMissing} /> : null}
        {lines.length > 0 ? (
          <ul className="st-list" aria-label={HEALTH_TEXT.protectionTitle}>
            {lines.map((l) => (
              <li key={l.text} className="st-field" data-protected={l.ok}>
                <div className="st-field-text flex items-start gap-3"><StatusBadge status={l.ok ? 'ok' : 'warn'} /><span className="st-row-title">{l.text}</span></div>
              </li>
            ))}
          </ul>
        ) : null}
      </SettingsGroup>
      <DataFolder dir={dataDir} failed={caps.data ? null : caps.error} onRetry={() => { void caps.refresh() }} />
      <SettingsGroup title={HEALTH_TEXT.developerTitle}>
        <ToggleField id="st-developerMode" label={HEALTH_TEXT.developerMode} value={developer}
          hint={HEALTH_TEXT.developerModeHint} savedLocally onChange={writeDeveloperMode}
          modified={developer} onReset={() => writeDeveloperMode(false)} />
      </SettingsGroup>
    </div>
  )
}
