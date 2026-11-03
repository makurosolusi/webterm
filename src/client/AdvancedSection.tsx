// Bagian "Lanjutan" (b §4): tepat empat butir, tertutup secara bawaan.
import { useState } from 'react'
import type { CapabilitiesResponse } from '../shared/featureCapabilities'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ADVANCED_TEXT, ENGINE_OPTIONS } from './advancedLabels'
import { callCapabilities } from './capabilitiesApi'
import { ChromiumPathField } from './ChromiumPathField'
import { capabilityErrorMessage } from './useCapabilities'

type Advanced = CapabilitiesResponse['advanced']

export interface AdvancedSectionProps {
  advanced: Advanced
  /** Dipanggil setelah server menerima perubahan, agar kartu memuat ulang. */
  onChanged(): Promise<void>
  /** Terbuka atau tidak; dikendalikan induk supaya tombol langkah di kartu Browser bisa membukanya. */
  open: boolean
  onOpenChange(open: boolean): void
}

/** Bagian Lanjutan: mesin agen, lokasi Chromium, folder data (baca-saja), setel ulang. */
export function AdvancedSection({ advanced, onChanged, open, onOpenChange }: AdvancedSectionProps): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)

  const run = async (suffix: string, method: string, body: unknown): Promise<void> => {
    try {
      await callCapabilities(suffix, method, body)
      setError(null)
      await onChanged()
    } catch (e) {
      setError(capabilityErrorMessage(e, ADVANCED_TEXT.changeFailed))
    }
  }

  return (
    <details className="st-capabilities-advanced" open={open} onToggle={(e) => onOpenChange(e.currentTarget.open)}>
      <summary>{ADVANCED_TEXT.summary}</summary>
      <div className="flex flex-col gap-1 py-2">
        <Label>{ADVANCED_TEXT.engineLabel}</Label>
        <Select value={advanced.agentEngine.value} onValueChange={(v) => void run('/advanced', 'PUT', { agentEngine: v })}>
          <SelectTrigger aria-label={ADVANCED_TEXT.engineLabel}><SelectValue /></SelectTrigger>
          <SelectContent>
            {ENGINE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <p className="m-0 text-xs opacity-70">{ADVANCED_TEXT.engineDetected(advanced.agentEngine.detected)}</p>
      </div>
      <ChromiumPathField chromium={advanced.chromiumPath}
        save={(chromiumPath) => run('/advanced', 'PUT', { chromiumPath })} redetect={onChanged} />
      <div className="flex flex-col gap-1 py-2">
        <span className="text-[13px]">{ADVANCED_TEXT.dataDirLabel}</span>
        <code className="text-xs break-all">{advanced.dataDir}</code>
      </div>
      <div className="flex flex-col gap-1 py-2">
        <Button size="sm" variant="outline" className="self-start" onClick={() => void run('/reset', 'POST', {})}>
          {ADVANCED_TEXT.reset}
        </Button>
        <p className="m-0 text-xs opacity-70">{ADVANCED_TEXT.resetHint}</p>
      </div>
      {error ? <p role="alert" className="m-0 text-xs text-destructive">{error}</p> : null}
    </details>
  )
}
