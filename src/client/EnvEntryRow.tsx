// Satu variabel env sebagai item Settings: `Webterm › Grup: Nama`, deskripsi, kontrol, Simpan/Reset.
import { useState } from 'react'
import { ENV, ENV_GROUP_LABEL, ENV_SOURCE_LABEL } from './envLabels'
import { EnvSecretField } from './EnvSecretField'
import { EnvValueControl } from './EnvValueControl'
import type { EnvEntry } from './envSettingsApi'
import { SettingsMessage } from './SettingsMessage'

export interface EnvRowProps {
  entry: EnvEntry
  locked: boolean
  busy: boolean
  error?: string
  onSave: (key: string, value: string) => Promise<boolean>
  onUnset: (key: string) => Promise<boolean>
}

function Tags({ entry }: { entry: EnvEntry }): React.JSX.Element {
  return (
    <>
      <span className={'st-tag' + (entry.source === 'override' ? ' st-tag--modified' : '')}>{ENV_SOURCE_LABEL[entry.source]}</span>
      {entry.restartRequired ? <span className="st-tag">{ENV.badgeRestart}</span> : null}
      {entry.pendingRestart ? <span className="st-tag">{ENV.badgePending}</span> : null}
      {entry.dangerous ? (
        <span className="st-tag st-tag--warning">
          <span className="codicon codicon-warning" aria-hidden="true" />{ENV.badgeDangerous}
        </span>
      ) : null}
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
    <li className={'st-env-row st-field' + (entry.source === 'override' ? ' is-modified' : '')} aria-label={entry.key}>
      <div className="st-title">
        <span className="st-category">{ENV.categoryRoot} › {ENV_GROUP_LABEL[entry.group] ?? entry.group}: </span>
        <strong className="st-label">{entry.label}</strong>
        <Tags entry={entry} />
      </div>
      <p className="st-hint">{entry.description}</p>
      <p className="st-hint"><code className="st-env-key">{entry.key}</code></p>
      {isSecret ? (
        <EnvSecretField entry={entry} disabled={disabled} onSave={onSave} onUnset={onUnset} />
      ) : (
        <div className="st-env-ctl">
          <EnvValueControl entry={entry} value={value} disabled={disabled} onChange={setDraft} />
          <button type="button" className="st-button st-button--primary" aria-label={`${ENV.save} ${entry.key}`}
            disabled={disabled || !dirty} onClick={() => void save()}>
            {ENV.save}
          </button>
          {entry.source === 'override' ? (
            <button type="button" className="st-button" aria-label={`${ENV.reset} ${entry.key}`}
              disabled={disabled} onClick={() => void onUnset(entry.key).then(() => setDraft(null))}>
              {ENV.reset}
            </button>
          ) : null}
        </div>
      )}
      {isSecret ? <p className="st-note">{ENV.secretHint}</p> : null}
      {entry.kind !== 'secret' && entry.default !== undefined ? (
        <p className="st-note">{ENV.defaultLabel}: {entry.default === '' ? ENV.none : entry.default}</p>
      ) : null}
      {entry.source === 'override' ? <p className="st-note">{isSecret ? ENV.removeHelp : ENV.resetHelp}</p> : null}
      {entry.dangerous && !entry.editable && !locked ? (
        <SettingsMessage kind="warning">{ENV.dangerousNeedsRoot}</SettingsMessage>
      ) : null}
      {error ? <SettingsMessage kind="error" role="alert">{error}</SettingsMessage> : null}
    </li>
  )
}
