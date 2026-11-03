// Peringatan lunak prasyarat (P-7): "Belum berpengaruh: butuh KEY = nilai" + tombol Buka; kontrol tidak di-disable.
import { Button } from '@/components/ui/button'
import { ENV } from './envLabels'
import { requiredValueText, unmetRequires } from './envRequires'
import type { EnvEntry } from './envSettingsApi'
import { SettingsMessage } from './SettingsMessage'

interface Props {
  entry: EnvEntry
  get: (key: string) => string | undefined
  onJump: (key: string) => void
}

/** Satu peringatan per prasyarat yang belum terpenuhi; kunci tak dikenal diabaikan. */
export function EnvRequiresNote({ entry, get, onJump }: Props): React.JSX.Element | null {
  const unmet = unmetRequires(entry, get)
  if (unmet.length === 0) return null
  return (
    <>
      {unmet.map((r) => (
        <div key={r.key} className="st-env-ctl">
          <SettingsMessage kind="warning">
            {ENV.requiresPrefix} <code className="st-env-key">{r.key}</code> = {requiredValueText(r)}{r.note ? ` (${r.note})` : ''}
          </SettingsMessage>
          <Button type="button" size="sm" variant="secondary" aria-label={`${ENV.requiresOpen} ${r.key}`} onClick={() => onJump(r.key)}>
            {ENV.requiresOpen}
          </Button>
        </div>
      ))}
    </>
  )
}
