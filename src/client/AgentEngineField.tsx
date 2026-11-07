// Butir "Mesin agen" di Lanjutan dan di tawaran Agent Pusat (pola sama dengan ChromiumPathField): pilihan mesin,
// status jujur (terdeteksi / belum terpasang / belum login), dan "Periksa lagi" (Orca AgentsPane: Refresh =
// "Re-read your shell PATH and re-detect installed agents"; di sini deteksi berjalan ulang di tiap GET).
import { useState } from 'react'
import type { CapabilitiesResponse } from '../shared/featureCapabilities'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ADVANCED_TEXT, ENGINE_OPTIONS, engineName } from './advancedLabels'
import { CentralLaunchStatus } from './claudeLauncher/CentralLaunchStatus'

type Engine = CapabilitiesResponse['advanced']['agentEngine']

export interface AgentEngineFieldProps {
  engine: Engine
  /** Mesin siap (terpasang + login) menurut server; undefined = belum diperiksa (Agent Pusat mati). */
  ready?: boolean
  save(value: Engine['value']): Promise<void>
  /** Muat ulang dari server; deteksi berjalan ulang di tiap GET. */
  redetect(): Promise<void>
}

/** Kalimat status: hanya yang benar-benar diketahui dari deteksi server. */
const statusText = (engine: Engine): string =>
  engine.detected === 'off' ? ADVANCED_TEXT.engineMissing : ADVANCED_TEXT.engineDetected(engineName(engine.detected))

/** Pilihan mesin agen + status + periksa ulang. */
export function AgentEngineField({ engine, ready, save, redetect }: AgentEngineFieldProps): React.JSX.Element {
  const [checking, setChecking] = useState(false)
  const [checks, setChecks] = useState(0)
  const recheck = async (): Promise<void> => {
    setChecking(true)
    try { await redetect() } finally { setChecking(false); setChecks((n) => n + 1) }
  }
  return (
    <div className="flex flex-col gap-1 py-2" data-field="agentEngine">
      <Label>{ADVANCED_TEXT.engineLabel}</Label>
      <Select value={engine.value} onValueChange={(v) => void save(v as Engine['value'])}>
        <SelectTrigger aria-label={ADVANCED_TEXT.engineLabel}><SelectValue /></SelectTrigger>
        <SelectContent>
          {ENGINE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
      <div className="flex flex-wrap items-center gap-2">
        {/* Not ready = Claude (the only engine) cannot start: show the launch profile's failing stage. */}
        {ready === false ? <CentralLaunchStatus version={checks} />
          : <p role="status" className="m-0 text-xs opacity-70">{statusText(engine)}</p>}
        <IconTooltip label={ADVANCED_TEXT.engineRecheckHint} disabled={checking} disabledReason={ADVANCED_TEXT.engineChecking}>
          <Button size="xs" variant="ghost" disabled={checking}
            onClick={() => void recheck()}>{checking ? ADVANCED_TEXT.engineChecking : ADVANCED_TEXT.engineRecheck}</Button>
        </IconTooltip>
      </div>
    </div>
  )
}
