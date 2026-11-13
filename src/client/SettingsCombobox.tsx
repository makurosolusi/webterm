// The one free-input control of Settings: a text box with a dropdown of presets plus the values this
// field was given before ("Recent", stored server-side, each removable). ARIA 1.2 combobox pattern
// (w3.org/WAI/ARIA/apg/patterns/combobox, "list autocomplete"). Built here rather than on
// vscode-single-select `creatable`: that list lives in a shadow root with no per-option remove
// button, and it exposes no live draft for previews such as the launch profile's "Will run".
// At rest the box shows the human label of the stored value (the matching preset's label, else
// `format(value)`), like macOS and Raycast; the raw value appears only while the box has focus.
// Not for `mono` boxes (commands, paths, ids), where the raw text is what the user needs to see.
import { useEffect, useId, useState, type Ref } from 'react'
import { IconTooltip } from '@/components/ui/icon-button'
import { forgetInput, rememberInput, useInputHistory } from './inputHistory.store'
import './settings-controls.css'
import './settings-pickers.css'

export interface ComboPreset { value: string; label?: string }

export interface SettingsComboboxProps {
  /** History key (`Settings.inputHistory`); fields sharing it share their Recent list. */
  fieldId: string
  value: string
  onCommit(value: string): void
  presets: readonly ComboPreset[]
  /** false for anything that could be a secret: nothing typed is stored. */
  remember?: boolean
  /** Trim the committed value (default). Off where leading/trailing spaces mean something. */
  trim?: boolean
  /** Error sentence for an invalid value, or null; invalid values are neither committed nor stored. */
  validate?(value: string): string | null
  /** Every keystroke, for live previews; commits still happen on Enter / blur / pick. */
  onDraft?(value: string): void
  /** An error owned by the caller (e.g. a form's Save attempt), shown when the field has none of its own. */
  error?: string
  maxLength?: number
  placeholder?: string
  disabled?: boolean
  id?: string
  ariaLabel?: string
  mono?: boolean
  /** Font list: each option is drawn in its own typeface (`fontFamily: value`). */
  fontPreview?: boolean
  /** Text shown at rest for a value with no preset label (e.g. "25,000 lines"). */
  format?(value: string): string
  inputRef?: Ref<HTMLInputElement>
}

interface Item { key: string; value: string; label: string; recent: boolean }

export const COMBO_TEXT = {
  presets: 'Suggestions',
  recent: 'Recent',
  open: 'Show suggestions',
  remove: (v: string): string => `Remove ${v} from recent`,
}

export function SettingsCombobox({
  fieldId, value, onCommit, presets, remember = true, trim = true, validate, onDraft, error: outerError, maxLength, placeholder, disabled, id, ariaLabel, mono, fontPreview, format, inputRef,
}: SettingsComboboxProps): React.JSX.Element {
  const uid = useId()
  const inputId = id ?? `combo-${uid}`
  const listId = `${inputId}-list`
  const [draft, setDraft] = useState(value)
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState(false)
  const [active, setActive] = useState(-1)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const history = useInputHistory(fieldId)
  useEffect(() => { setDraft(value); setError(null) }, [value])

  const presetValues = new Set(presets.map((p) => p.value))
  const recent = remember ? history.filter((h) => !presetValues.has(h)) : []
  const q = filter ? draft.trim().toLowerCase() : ''
  const hit = (s: string): boolean => !q || s.toLowerCase().includes(q)
  const items: Item[] = [
    ...presets.filter((p) => hit(p.value) || hit(p.label ?? '')).map((p) => ({ key: `p:${p.value}`, value: p.value, label: p.label ?? p.value, recent: false })),
    ...recent.filter(hit).map((v) => ({ key: `r:${v}`, value: v, label: v, recent: true })),
  ]
  const shown = open && items.length > 0
  // A `mono` box holds code-like text (command, path, capability, cron) whose raw form is the meaning:
  // it keeps showing the raw value. A font list (`fontPreview`) still shows the family name.
  const labelled = !mono || fontPreview
  const atRest = labelled ? presets.find((p) => p.value === draft)?.label ?? (draft && format ? format(draft) : draft) : draft
  const shownError = error ?? outerError

  const show = (): void => {
    if (!disabled) setOpen(true)
  }
  const close = (): void => { setOpen(false); setFilter(false); setActive(-1) }
  const setText = (v: string): void => { setDraft(v); setError(null); onDraft?.(v) }

  const commit = (raw: string): void => {
    close()
    const v = trim ? raw.trim() : raw
    const err = validate?.(v) ?? null
    setError(err)
    if (err) return
    if (v !== raw) setText(v)
    if (v !== value) onCommit(v)
    if (remember && v.trim() && !presetValues.has(v)) void rememberInput(fieldId, v)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) { show(); setActive(e.key === 'ArrowDown' ? 0 : items.length - 1); return }
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((a) => (items.length ? (a + step + items.length) % items.length : -1))
    } else if (e.key === 'Enter') {
      const pick = shown && active >= 0 ? items[active] : undefined
      if (pick) { e.preventDefault(); setText(pick.value); commit(pick.value) } else commit(draft)
    } else if (e.key === 'Escape' && open) {
      // Closing the list is this Escape's whole job; the dialog around it stays open.
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }

  return (
    // While the list is open Escape belongs to it: the marker keeps Settings' capture-phase Escape off.
    <span className="st-combo" data-settings-escape={open ? '' : undefined}>
      <span className="st-combo-box">
        <input
          ref={inputRef}
          id={inputId}
          className={'st-input st-combo-input' + (mono ? ' st-mono' : '')}
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={shown}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={shown && active >= 0 ? `${listId}-${active}` : undefined}
          aria-invalid={shownError ? true : undefined}
          aria-describedby={shownError ? `${inputId}-err` : undefined}
          maxLength={maxLength}
          data-field-id={fieldId}
          autoComplete="off"
          spellCheck={false}
          value={editing ? draft : atRest}
          placeholder={placeholder}
          disabled={disabled}
          onFocus={() => setEditing(true)}
          onChange={(e) => { setEditing(true); setText(e.target.value); setFilter(true); setActive(-1); show() }}
          onKeyDown={(e) => { setEditing(true); onKeyDown(e) }}
          onBlur={() => { setEditing(false); if (open || draft !== value) commit(draft) }}
        />
        <IconTooltip label={COMBO_TEXT.open}>
          <button type="button" className="st-combo-toggle" tabIndex={-1} aria-label={COMBO_TEXT.open} disabled={disabled}
            aria-controls={listId} aria-expanded={shown}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => (open ? close() : show())}>
            <span className="codicon codicon-chevron-down" aria-hidden="true" />
          </button>
        </IconTooltip>
      </span>
      <div id={listId} role="listbox" className="st-combo-list" hidden={!shown}
        onMouseDown={(e) => e.preventDefault()}>
        {[false, true].map((isRecent) => {
          const group = items.map((it, i) => [it, i] as const).filter(([it]) => it.recent === isRecent)
          if (!group.length) return null
          const title = isRecent ? COMBO_TEXT.recent : COMBO_TEXT.presets
          return (
            <div key={title} role="group" aria-labelledby={`${listId}-${title}`} className="st-combo-group">
              <div id={`${listId}-${title}`} role="presentation" className="st-combo-heading">{title}</div>
              {group.map(([it, i]) => (
                <div key={it.key} id={`${listId}-${i}`} role="option" aria-selected={i === active}
                  className={'st-combo-option' + (i === active ? ' is-active' : '')}
                  onClick={() => { setText(it.value); commit(it.value) }}>
                  <span className={'st-combo-label' + (mono ? ' st-mono' : '')} style={fontPreview ? { fontFamily: it.value } : undefined}>{it.label}</span>
                  {it.label !== it.value && !fontPreview ? <span className="st-combo-value st-mono">{it.value}</span> : null}
                  {it.recent ? (
                    <IconTooltip label={COMBO_TEXT.remove(it.value)}>
                      <button type="button" className="st-combo-remove" tabIndex={-1} aria-label={COMBO_TEXT.remove(it.value)}
                        onClick={(e) => { e.stopPropagation(); void forgetInput(fieldId, it.value) }}>
                        <span className="codicon codicon-close" aria-hidden="true" />
                      </button>
                    </IconTooltip>
                  ) : null}
                </div>
              ))}
            </div>
          )
        })}
      </div>
      {shownError ? <span id={`${inputId}-err`} role="alert" className="st-combo-error">{shownError}</span> : null}
    </span>
  )
}
