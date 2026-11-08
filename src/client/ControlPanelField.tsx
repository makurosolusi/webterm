// Editor cell of one Control row, following the VS Code Settings editor: the control comes from the
// setting type (boolean -> checkbox, enum -> dropdown, number/string -> text box, contributes.configuration
// docs), a "Reset Setting" action on modified values, and settings set outside the editor (VS Code
// policy, `@haspolicy`) shown read-only with the reason. code.visualstudio.com/docs/configure/settings
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import type { EffectiveRow } from './ControlPanel'
import { CONTROL_TEXT } from './controlPanelLabels'
import { SettingsCheckbox, SettingsSelect } from './SettingsControls'
import { SettingsCombobox } from './SettingsCombobox'

/** A write: set one key, or reset it (unset). Resolves to an error sentence, or null when saved. */
export type ControlWrite = (key: string, value: string | null) => Promise<string | null>

const isNumber = (v: string): string | null => (v === '' || Number.isFinite(Number(v)) ? null : CONTROL_TEXT.notANumber)

/** Plain (non-secret) text or number: combobox with the default and known options as suggestions,
 *  plus the values entered before. Range checks stay on the server, the one validator. */
function TextField({ row, write }: { row: EffectiveRow; write: ControlWrite }): React.JSX.Element {
  const presets = [...new Set([row.default ?? '', ...(row.options ?? [])].filter(Boolean))]
    .map((v) => ({ value: v, label: v === row.default ? `${v} (default)` : row.optionLabels?.[v] ?? v }))
  return (
    <span data-control={row.key} className="min-w-40 flex-1">
      <SettingsCombobox ariaLabel={row.label} fieldId={`control.${row.key}`} value={row.setting} placeholder={row.default}
        presets={presets} validate={row.kind === 'number' ? isNumber : undefined} onCommit={(v) => void write(row.key, v)} />
    </span>
  )
}

function SecretField({ row, write }: { row: EffectiveRow; write: ControlWrite }): React.JSX.Element {
  const [draft, setDraft] = useState('')
  return (
    <span className="flex items-center gap-1">
      <Input aria-label={row.label} data-control={row.key} type="password" autoComplete="off" value={draft}
        placeholder={CONTROL_TEXT.secretPlaceholder} className="h-7 text-xs" onChange={(e) => setDraft(e.target.value)} />
      <Button size="sm" variant="secondary" disabled={draft === ''}
        onClick={() => void write(row.key, draft).then((err) => { if (err === null) setDraft('') })}>{CONTROL_TEXT.save}</Button>
    </span>
  )
}

function Editor({ row, write }: { row: EffectiveRow; write: ControlWrite }): React.JSX.Element {
  if (row.kind === 'flag') {
    return <span data-control={row.key}><SettingsCheckbox ariaLabel={row.label} checked={row.setting === 'on'} onChange={(on) => void write(row.key, on ? 'on' : 'off')} /></span>
  }
  if (row.kind === 'enum' && row.options) {
    const options = row.options.map((o) => ({ value: o, label: row.optionLabels?.[o] ?? o }))
    return <span data-control={row.key}><SettingsSelect ariaLabel={row.label} value={row.setting} options={options} onChange={(v) => void write(row.key, v)} /></span>
  }
  if (row.kind === 'secret') return <SecretField row={row} write={write} />
  return <TextField row={row} write={write} />
}

/** Control cell: editor + reset + apply note, or the lock / "managed in" explanation. */
export function ControlField({ row, write }: { row: EffectiveRow; write: ControlWrite }): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const run: ControlWrite = async (key, value) => {
    setBusy(true)
    const err = await write(key, value)
    setBusy(false)
    setError(err)
    return err
  }
  if (!row.editable) {
    if (row.lockReason) return <span data-locked={row.key} title={row.lockReason}><strong>{CONTROL_TEXT.locked}:</strong> {row.lockReason}</span>
    return <em className="opacity-70">{row.ui ? CONTROL_TEXT.managedIn(row.ui) : CONTROL_TEXT.noUi}</em>
  }
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1">
        <Editor row={row} write={run} />
        {row.source === 'settings' ? (
          <IconTooltip label={CONTROL_TEXT.resetTitle}>
            <Button size="sm" variant="ghost" onClick={() => void run(row.key, null)}>{CONTROL_TEXT.reset}</Button>
          </IconTooltip>
        ) : null}
        {busy ? <span className="opacity-70">{CONTROL_TEXT.saving}</span> : null}
      </span>
      <span className="opacity-70">{row.pendingRestart ? CONTROL_TEXT.restartPending : CONTROL_TEXT.restart[row.restart]}</span>
      {row.dangerNote ? <span className="text-amber-600">{row.dangerNote}</span> : null}
      {error ? <span role="alert" className="text-destructive">{CONTROL_TEXT.writeFailed(error)}</span> : null}
    </div>
  )
}
