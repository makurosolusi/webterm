// Butir "Mesin agen" di Lanjutan dan di tawaran Agent Pusat (pola sama dengan ChromiumPathField): pilihan mesin,
// status jujur (terdeteksi / belum terpasang / belum login), dan "Periksa lagi" (Orca AgentsPane: Refresh =
// "Re-read your shell PATH and re-detect installed agents"; di sini deteksi berjalan ulang di tiap GET).
import { useState } from 'react'
import type { CapabilitiesResponse } from '../shared/featureCapabilities'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ADVANCED_TEXT, ENGINE_OPTIONS, engineName } from './advancedLabels'

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
function statusText(engine: Engine, ready: boolean | undefined): string {
  if (engine.detected === 'off') return ADVANCED_TEXT.engineMissing
  if (ready !== false) return ADVANCED_TEXT.engineDetected(engineName(engine.detected))
  // Terpasang tapi belum siap: untuk mesin terdeteksi itu berarti belum login; pilihan lain bisa juga belum terpasang.
  return engine.value === 'auto' || engine.value === engine.detected
    ? ADVANCED_TEXT.engineNotLoggedIn(engineName(engine.detected))
    : ADVANCED_TEXT.engineChosenNotReady(engineName(engine.value))
}

/** Pilihan mesin agen + status + periksa ulang. */
export function AgentEngineField({ engine, ready, save, redetect }: AgentEngineFieldProps): React.JSX.Element {
  const [checking, setChecking] = useState(false)
  const recheck = async (): Promise<void> => {
    setChecking(true)
    try { await redetect() } finally { setChecking(false) }
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
        <p role="status" className={`m-0 text-xs ${ready === false ? 'text-destructive' : 'opacity-70'}`}>{statusText(engine, ready)}</p>
        <Button size="xs" variant="ghost" disabled={checking} title={ADVANCED_TEXT.engineRecheckHint}
          onClick={() => void recheck()}>{checking ? ADVANCED_TEXT.engineChecking : ADVANCED_TEXT.engineRecheck}</Button>
      </div>
    </div>
  )
}
