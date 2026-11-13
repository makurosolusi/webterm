// One Settings row (`Field`), shared by every page: macOS System Settings / GitHub anatomy. Left: label
// (page prefix only while searching), the modified dot + Reset, the save status in a slot on the label
// line (no layout shift), then the description, safeguard and lock reason. Right: the control,
// right-aligned. `block` puts a wide control (list, preview, swatches) under the text at full width.
// Below ~520 px of content the row stacks (container query in settings.css).
//
// Search: `SettingsSearchProvider` carries the normalized query and a `Field` hides itself when its
// label + hint do not match, so the filter works for every section without a separate list.
import { createContext, useContext, useId, useState, type ReactNode } from 'react'
// Here, not in the lazily loaded SettingsPanel: these fields also render outside it (canvas background,
// projects folder), and their `.st-*` styles must not wait for the panel's first open.
import './settings.css'
import './settings-controls.css'
import './settings-field.css'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { DisabledReason, type Lock } from '@/components/ui/disabled-reason'
import { Label } from '@/components/ui/label'
import type { Settings } from '../shared/settings'
import { safeguardFor } from '../shared/settings.safeguards'
import type { SettingsFieldId } from './settings.link'
import { isModified, resetPatch, useSettingsItemScope } from './settingsContext'
import { useFieldSave, type FieldSave } from './settingsSave'
import { settingsSaves } from './useSettings'

const SearchContext = createContext('')

/** Normalize a query: trim + lowercase. Tokens are split on spaces and must ALL match. */
export function normalizeQuery(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function matchesSearch(text: string, query: string): boolean {
  if (!query) return true
  const haystack = text.toLowerCase()
  return query.split(' ').every((token) => haystack.includes(token))
}

/** Field status words (Rule 15: one place). */
export const FIELD_TEXT = {
  modified: '(Modified)',
  reset: 'Reset',
  resetLabel: (label: string): string => `Reset Setting: ${label}`,
  saving: 'Saving…',
  saved: 'Saved',
  savedLocally: 'Saved on this browser',
  saveFailed: (why: string): string => `Could not save: ${why}`,
  retry: 'Retry',
} as const

/** Save status of a field: Saving… / Saved ✓ (status), or the error with Retry (alert). */
export function FieldSaveStatus({ save }: { save: FieldSave | undefined }): React.JSX.Element | null {
  if (!save) return null
  if (save.status === 'error') {
    return (
      <span role="alert" className="st-save st-save--error" data-save="error">
        <span className="codicon codicon-error" aria-hidden="true" />
        <span>{FIELD_TEXT.saveFailed(save.message)}</span>
        <button type="button" className="st-save-retry" onClick={save.retry}>{FIELD_TEXT.retry}</button>
      </span>
    )
  }
  return (
    <span role="status" className="st-save" data-save={save.status}>
      {save.status === 'saved'
        ? <><span className="codicon codicon-check" aria-hidden="true" />{save.where === 'browser' ? FIELD_TEXT.savedLocally : FIELD_TEXT.saved}</>
        : FIELD_TEXT.saving}
    </span>
  )
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Marks each query token in `text` (`.st-mark`), as VS Code does for matched text. */
export function highlightMatches(text: string, query: string): ReactNode {
  if (!query) return text
  const tokens = query.split(' ').filter(Boolean).map(escapeRegExp)
  if (tokens.length === 0) return text
  const re = new RegExp(`(${tokens.join('|')})`, 'ig')
  const parts = text.split(re)
  return parts.map((part, index) => {
    const hit = tokens.some((token) => new RegExp(`^${token}$`, 'i').test(part))
    return hit ? <mark key={index} className="st-mark">{part}</mark> : part
  })
}

/**
 * Confirm title for resetting `value`, or null for an instant reset. Only user-built data (a
 * non-empty list or map) asks first: one click would otherwise wipe all of it.
 */
export function resetConfirmTitle(value: unknown, label: string): string | null {
  if (Array.isArray(value)) return value.length ? `Remove all ${value.length} ${label}?` : null
  if (value && typeof value === 'object') {
    const n = Object.keys(value).length
    return n ? `Reset ${label}? ${n} ${n === 1 ? 'entry' : 'entries'} will be removed.` : null
  }
  return null
}

export function useSettingsSearch(): string {
  return useContext(SearchContext)
}

export function SettingsSearchProvider({ query, children }: { query: string; children: ReactNode }): React.JSX.Element {
  return <SearchContext.Provider value={query}>{children}</SearchContext.Provider>
}

/** Why a field keeps a restrictive default (shared/settings.safeguards.ts); nothing for an ordinary field. */
export function SafeguardNote({ id }: { id: string | undefined }): React.JSX.Element | null {
  const reason = safeguardFor(id)
  return reason ? <p className="st-hint st-safeguard" data-safeguard={id}>{reason}</p> : null
}

/** id of a field's lock reason line, for the control's `aria-describedby`. */
export const lockReasonId = (controlId: string): string => `${controlId}-lock`

export interface FieldProps {
  label: string
  /** One plain sentence; a string so search can read it. */
  hint?: string
  /** 'warning': the hint reads as a caution (e.g. Skip approvals on). */
  tone?: 'warning'
  htmlFor?: string
  /** A wide control (list, launch command rows, agent cards): under the text, full row width. */
  block?: boolean
  /** The Settings key this row stands for; turns on the modified dot, Reset and its save status. */
  setting?: keyof Settings
  /** Deep-link id (`data-field`, ./settings.link) when it is not `setting`. */
  field?: SettingsFieldId
  /** Locked by another setting: the hint stays, a reason line (+ fix) follows; the control must be
   *  disabled with `aria-describedby={lockReasonId(htmlFor)}` (SelectField/ToggleField/StepperField do it). */
  lock?: Lock
  /** Save state when not a `setting` (env-backed or browser-stored rows); a `setting` reads its own. */
  save?: FieldSave
  /** Differs from its default, when not a `setting`; shows the dot (+ Reset with `onReset`). */
  modified?: boolean
  /** Back to the default, when not a `setting`. */
  onReset?: () => void
  children: ReactNode
}

export function Field({ label, hint, htmlFor, block, setting, field, lock, tone, save, modified: modifiedProp, onReset, children }: FieldProps): React.JSX.Element | null {
  const query = useSettingsSearch()
  const { category, settings, onChange } = useSettingsItemScope()
  const [confirming, setConfirming] = useState<string | null>(null)
  const autoId = useId()
  const settingSave = useFieldSave(setting ? settingsSaves : undefined, setting)
  const fieldId = field ?? setting
  if (!matchesSearch(`${label} ${hint ?? ''} ${lock?.reason ?? ''} ${safeguardFor(fieldId) ?? ''}`, query)) return null

  const modified = setting !== undefined && settings !== undefined ? isModified(settings, setting) : !!modifiedProp
  const reset = setting !== undefined
    ? (settings && onChange ? () => {
        const ask = resetConfirmTitle(settings[setting], label)
        if (ask) setConfirming(ask)
        else onChange(resetPatch(setting, settings))
      } : undefined)
    : onReset
  return (
    <div
      className={'st-field' + (block ? ' st-field--block' : '') + (modified ? ' is-modified' : '')}
      data-slot="settings-field"
      data-field={fieldId}
    >
      <div className="st-field-text">
        <div className="st-title">
          {/* Page prefix only in search results (query set), and never "Central Agent: Central Agent". */}
          {category && query && category !== label ? <span className="st-category">{category}: </span> : null}
          <Label className="st-label" htmlFor={htmlFor}>{highlightMatches(label, query)}</Label>
          {modified ? <span className="st-modified-dot" title="Modified"><span className="sr-only">{FIELD_TEXT.modified}</span></span> : null}
          {modified && reset && !lock ? (
            <button type="button" className="st-reset" aria-label={FIELD_TEXT.resetLabel(label)} onClick={reset}>{FIELD_TEXT.reset}</button>
          ) : null}
          <FieldSaveStatus save={save ?? settingSave} />
        </div>
        {hint ? <p className={'st-hint' + (tone === 'warning' ? ' st-hint--warning' : '')}>{hint}</p> : null}
        <SafeguardNote id={fieldId} />
        {lock ? <DisabledReason id={htmlFor ? lockReasonId(htmlFor) : autoId} {...lock} /> : null}
      </div>
      <div className="st-control">{children}</div>
      {confirming !== null && setting && onChange ? (
        <AlertDialog open onOpenChange={(open) => { if (!open) setConfirming(null) }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{confirming}</AlertDialogTitle>
              <AlertDialogDescription>{`"${label}" goes back to its default. Undo is offered right after.`}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel autoFocus>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => onChange(resetPatch(setting, settings))}>Reset</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  )
}
