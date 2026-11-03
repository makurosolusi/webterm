// Input secret write-only: tak pernah diisi dari server; draft hidup di provider dan dikosongkan setelah simpan massal.
import { useRef } from 'react'
import { Input } from '@/components/ui/input'
import { ENV } from './envLabels'
import type { EnvEntry } from './envSettingsApi'

interface Props {
  entry: EnvEntry
  /** Id input, target `<label htmlFor>` baris. */
  id: string
  describedBy?: string
  draft?: string
  disabled: boolean
  onDraft: (value: string) => void
  onReset: () => void
}

/** Status Terisi/Kosong + input password (draft massal) + Hapus langsung; fokus kembali ke input setelah Hapus. */
export function EnvSecretField({ entry, id, describedBy, draft, disabled, onDraft, onReset }: Props): React.JSX.Element {
  const input = useRef<HTMLInputElement>(null)
  const isSet = entry.secretSet ?? entry.set ?? false
  const state = isSet ? (entry.source === 'env' ? `${ENV.secretSet} (${ENV.secretFromEnv})` : ENV.secretSet) : ENV.secretUnset
  return (
    <div className="st-env-ctl">
      <span className="st-muted st-secret-state">{state}</span>
      <Input id={id} ref={input} className="st-input st-mono" type="password" autoComplete="new-password" spellCheck={false}
        aria-describedby={describedBy} placeholder={ENV.secretPlaceholder} value={draft ?? ''} disabled={disabled}
        onChange={(e) => onDraft(e.target.value)} />
      {entry.source === 'override' && isSet ? (
        <button type="button" className="st-button" aria-label={`${ENV.remove} ${entry.key}`} title={ENV.removeHelp}
          disabled={disabled} onClick={() => { onReset(); input.current?.focus() }}>
          {ENV.remove}
        </button>
      ) : null}
    </div>
  )
}
