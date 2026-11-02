// Satu baris variabel env: label, badge, kontrol, Simpan/Reset, dan error per entri.
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ENV, ENV_SOURCE_LABEL } from './envLabels'
import { EnvSecretField } from './EnvSecretField'
import { EnvValueControl } from './EnvValueControl'
import type { EnvEntry } from './envSettingsApi'

export interface EnvRowProps {
  entry: EnvEntry
  locked: boolean
  busy: boolean
  error?: string
  onSave: (key: string, value: string) => Promise<boolean>
  onUnset: (key: string) => Promise<boolean>
}

function Badges({ entry }: { entry: EnvEntry }): React.JSX.Element {
  return (
    <>
      <Badge variant={entry.source === 'override' ? 'default' : 'secondary'}>{ENV_SOURCE_LABEL[entry.source]}</Badge>
      {entry.restartRequired ? <Badge variant="outline">{ENV.badgeRestart}</Badge> : null}
      {entry.pendingRestart ? <Badge variant="outline">{ENV.badgePending}</Badge> : null}
      {entry.dangerous ? <Badge variant="destructive">{ENV.badgeDangerous}</Badge> : null}
    </>
  )
}

/** Baris entri non-bootstrap; bootstrap dirender terpisah (read-only). */
export function EnvEntryRow({ entry, locked, busy, error, onSave, onUnset }: EnvRowProps): React.JSX.Element {
  // null = belum diedit: kontrol mengikuti nilai server (otomatis segar setelah PUT).
  const [draft, setDraft] = useState<string | null>(null)
  const disabled = locked || !entry.editable || busy
  const isSecret = entry.kind === 'secret'
  const value = draft ?? entry.value ?? ''
  const dirty = draft !== null && draft !== (entry.value ?? '')
  const save = async (): Promise<void> => {
    if (await onSave(entry.key, value)) setDraft(null)
  }
  return (
    <li className="st-env-row" aria-label={entry.key}>
      <div className="st-env-head">
        <strong>{entry.label}</strong>
        <code className="st-mono">{entry.key}</code>
        <Badges entry={entry} />
      </div>
      <p className="st-hint">{entry.description}</p>
      {isSecret ? (
        <EnvSecretField entry={entry} disabled={disabled} onSave={onSave} onUnset={onUnset} />
      ) : (
        <div className="st-env-ctl">
          <EnvValueControl entry={entry} value={value} disabled={disabled} onChange={setDraft} />
          <Button type="button" variant="default" size="sm" className="st-button" aria-label={`${ENV.save} ${entry.key}`}
            disabled={disabled || !dirty} onClick={() => void save()}>
            {ENV.save}
          </Button>
          {entry.source === 'override' ? (
            <Button type="button" variant="secondary" size="sm" className="st-button" aria-label={`${ENV.reset} ${entry.key}`}
              disabled={disabled} onClick={() => void onUnset(entry.key).then(() => setDraft(null))}>
              {ENV.reset}
            </Button>
          ) : null}
        </div>
      )}
      {isSecret ? <p className="st-note">{ENV.secretHint}</p> : null}
      {entry.kind !== 'secret' && entry.default !== undefined ? (
        <p className="st-note">{ENV.defaultLabel}: {entry.default === '' ? ENV.none : entry.default}</p>
      ) : null}
      {entry.source === 'override' ? <p className="st-note">{isSecret ? ENV.removeHelp : ENV.resetHelp}</p> : null}
      {entry.dangerous && !entry.editable && !locked ? <p className="st-note">{ENV.dangerousNeedsRoot}</p> : null}
      {error ? <p className="st-ch-err" role="alert">{error}</p> : null}
    </li>
  )
}
