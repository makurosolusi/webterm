// Input secret write-only: tak pernah diisi dari server; draft dikosongkan begitu request selesai.
import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ENV } from './envLabels'
import type { EnvEntry } from './envSettingsApi'

interface Props {
  entry: EnvEntry
  disabled: boolean
  onSave: (key: string, value: string) => Promise<boolean>
  onUnset: (key: string) => Promise<boolean>
}

/** Status terisi/kosong + input password + Simpan/Hapus untuk satu secret. */
export function EnvSecretField({ entry, disabled, onSave, onUnset }: Props): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const id = useId()
  const save = async (): Promise<void> => {
    const value = draft
    try {
      await onSave(entry.key, value)
    } finally {
      setDraft('') // sukses atau gagal: nilai secret tidak boleh tertinggal di state
    }
  }
  return (
    <div className="st-env-ctl">
      <span className="st-muted">{entry.set ? ENV.secretSet : ENV.secretUnset}</span>
      <label className="st-sr-only" htmlFor={id}>{`${entry.label} (${entry.key})`}</label>
      <Input id={id} className="st-input st-mono" type="password" autoComplete="new-password" spellCheck={false}
        placeholder={ENV.secretPlaceholder} value={draft} disabled={disabled}
        onChange={(e) => setDraft(e.target.value)} />
      <Button type="button" variant="default" size="sm" className="st-button" aria-label={`${ENV.save} ${entry.key}`}
        disabled={disabled || draft === ''} onClick={() => void save()}>
        {ENV.save}
      </Button>
      {entry.source === 'override' && entry.set ? (
        <Button type="button" variant="secondary" size="sm" className="st-button" aria-label={`${ENV.remove} ${entry.key}`}
          disabled={disabled} onClick={() => void onUnset(entry.key)}>
          {ENV.remove}
        </Button>
      ) : null}
    </div>
  )
}
