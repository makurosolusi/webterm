// Satu variabel env sebagai item Settings: judul + kontrol, deskripsi, KEY + badge; nilai ada di draft provider.
import { useId, useRef } from 'react'
import { ENV } from './envLabels'
import { EnvBadges } from './EnvBadges'
import { EnvRequiresNote } from './EnvRequiresNote'
import { EnvSecretField } from './EnvSecretField'
import { EnvValueControl, isSwitch, localError } from './EnvValueControl'
import { activeDiffers } from './envRequires'
import type { EnvEntry } from './envSettingsApi'
import { SettingsMessage } from './SettingsMessage'

export interface EnvEntryRowProps {
  entry: EnvEntry
  draft?: string
  onDraft: (value: string) => void
  onReset: () => void
  get: (key: string) => string | undefined
  onJump: (key: string) => void
  locked: boolean
  rootGate: boolean
}

const show = (v: string): string => (v === '' ? ENV.none : v)

/** Baris satu entri env; simpan massal di bar provider (tanpa Simpan per baris); `rootGate` dipakai kartu tunggal ENV-03, baris tidak mengulang pesan. */
export function EnvEntryRow({ entry, draft, onDraft, onReset, get, onJump, locked }: EnvEntryRowProps): React.JSX.Element {
  const uid = useId()
  const ctlId = `${uid}-ctl`, descId = `${uid}-desc`, errId = `${uid}-err`, dangerId = `${uid}-danger`
  const ctl = useRef<HTMLDivElement>(null)
  const isSecret = entry.kind === 'secret'
  const disabled = locked || !entry.editable
  // Enum tak sah: server mengirim nilai bawaan + rawValue; tampilkan rawValue supaya opsi "tidak sah" terlihat.
  const stored = !entry.valid && entry.kind === 'enum' ? (entry.rawValue ?? entry.value) : entry.value
  const shown = draft ?? stored
  const error = draft !== undefined ? localError(entry, draft) : entry.valid ? undefined : (entry.invalidReason ?? ENV.errInvalidStored)
  const defText = entry.effectiveDefault ?? entry.default ?? ''
  const resettable = !isSecret && (entry.source === 'override' || draft !== undefined)
  const describedBy = [descId, error ? errId : '', entry.dangerNote ? dangerId : ''].filter(Boolean).join(' ')
  const reset = (): void => {
    // Draft belum tersimpan di server: cukup kembalikan ke nilai tersimpan; override tersimpan: minta unset.
    if (entry.source === 'override') onReset()
    else onDraft(stored)
    ctl.current?.querySelector<HTMLElement>('input,select')?.focus()
  }
  const control = isSecret ? (
    <EnvSecretField entry={entry} id={ctlId} describedBy={describedBy} draft={draft} disabled={disabled}
      onDraft={onDraft} onReset={onReset} />
  ) : (
    <EnvValueControl entry={entry} value={shown} disabled={disabled} onChange={onDraft} id={ctlId}
      describedBy={describedBy} invalid={error !== undefined} />
  )
  const inline = isSwitch(entry)
  return (
    <li className="st-env-row st-field" data-slot="settings-field" data-env-key={entry.key} aria-label={entry.key}>
      <div className="st-title" style={inline ? { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } : undefined}>
        <label className="st-label" htmlFor={ctlId}><strong>{entry.label}</strong></label>
        {inline ? <span ref={ctl}>{control}</span> : null}
      </div>
      <p className="st-hint" id={descId}>{entry.description}</p>
      <p className="st-hint"><code className="st-env-key">{entry.key}</code> <EnvBadges entry={entry} shown={shown} dangerId={dangerId} /></p>
      {inline ? null : <div ref={ctl}>{control}</div>}
      {resettable ? (
        <div className="st-env-ctl">
          {shown.trim().toLowerCase() !== (entry.default ?? '').trim().toLowerCase() ? (
            <span className="st-muted">{ENV.defaultLabel}: {show(defText)}</span>
          ) : null}
          <button type="button" className="st-button" title={ENV.resetHelp} aria-label={`${ENV.reset} ${entry.key}`}
            disabled={disabled} onClick={reset}>
            {ENV.reset}
          </button>
        </div>
      ) : null}
      {!isSecret && activeDiffers(entry) ? (
        <p className="st-note">{ENV.activeNow}: {show(entry.effective)} · {ENV.storedValue}: {show(entry.value)}</p>
      ) : null}
      <EnvRequiresNote entry={entry} get={get} onJump={onJump} />
      {entry.dangerNote ? <p className="st-note" id={dangerId}>{entry.dangerNote}</p> : null}
      {error ? <div id={errId}><SettingsMessage kind="error" role="alert">{error}</SettingsMessage></div> : null}
    </li>
  )
}
