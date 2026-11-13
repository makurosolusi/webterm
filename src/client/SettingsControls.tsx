// Shared controls of every Settings page: dropdown (native `<select>`, so label association, keyboard and
// the OS popup need no re-implementation), checkbox (multi-select lists only; on/off settings use the
// shadcn Switch through ToggleField), segmented choice (WAI-ARIA radio group, manual activation), the grouped card a page
// is built from (macOS System Settings / Linear: heading above a bordered card, divider between rows),
// and the page's one "Advanced" collapsible.
import { Children, useId, useRef, useState } from 'react'
import './settings-controls.css'

const SELECT_TEXT = { notInList: (value: string): string => `${value} (not in list)` } as const

interface SelectProps<T extends string> {
  id?: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  disabled?: boolean
  ariaLabel?: string
  /** id of the line that says why it is disabled (Field `lock`). */
  describedBy?: string
}

/** The one dropdown style in Settings: control height, dropdown tokens, codicon chevron, long text ellipsised. */
export function SettingsSelect<T extends string>({
  id,
  value,
  options,
  onChange,
  disabled,
  ariaLabel,
  describedBy,
}: SelectProps<T>): React.JSX.Element {
  // A stored value outside the list (old preset, deleted profile) would render a blank native select:
  // show it as a disabled first option so the control says what is really stored.
  const known = options.some((o) => o.value === value)
  return (
    <span className="st-select-wrap">
      <select
        id={id}
        className="st-select"
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {known ? null : <option value={value} disabled>{SELECT_TEXT.notInList(value)}</option>}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <span className="codicon codicon-chevron-down st-select-chevron" aria-hidden="true" />
    </span>
  )
}

/** Checkbox for multi-select lists (Add-menu agents): a transparent native input over a drawn box. */
export function SettingsCheckbox({
  id,
  checked,
  onChange,
  disabled,
  ariaLabel,
  describedBy,
}: {
  id?: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  ariaLabel?: string
  /** id of the line that says why it is disabled (Field `lock`). */
  describedBy?: string
}): React.JSX.Element {
  return (
    <span className="st-checkbox">
      <input
        id={id}
        type="checkbox"
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="st-checkbox-box" aria-hidden="true">
        <span className="codicon codicon-check" />
      </span>
    </span>
  )
}

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  /** A small decorative mark before the label (cursor shape █ ▏ ▁, a theme swatch). */
  glyph?: React.ReactNode
}

const STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }

/** One-of-few choice (2-4 options): a radio group with a single roving tab stop. Arrow/Home/End only move
 *  focus; Space, Enter or a click commits.
 *  Deviation from the APG radio group (where arrows also check): it follows the APG "manual activation"
 *  pattern (https://www.w3.org/WAI/ARIA/apg/patterns/tabs/ — "Deciding When to Make Selection Automatically
 *  Follow Focus") because a choice here has side effects (a POST, a Central restart): arrow keys pressed to
 *  scroll must never rewrite a setting. */
export function SettingsSegmented<T extends string>({ id, value, options, onChange, ariaLabel, disabled, describedBy }: {
  id?: string
  value: T
  options: readonly SegmentedOption<T>[]
  onChange(value: T): void
  ariaLabel?: string
  disabled?: boolean
  /** id of the line that says why it is disabled (Field `lock`). */
  describedBy?: string
}): React.JSX.Element {
  const group = useRef<HTMLSpanElement>(null)
  const [focused, setFocused] = useState<number | null>(null) // roving tab stop while focus is inside
  const selected = Math.max(0, options.findIndex((o) => o.value === value))
  const stop = focused ?? selected
  const pick = (i: number): void => { if (options[i]!.value !== value) onChange(options[i]!.value) }
  const keys = (e: React.KeyboardEvent, i: number): void => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); pick(i); return } // the only key commit
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1
      : STEP[e.key] ? (i + STEP[e.key]! + options.length) % options.length : null
    if (next === null) return
    e.preventDefault()
    group.current?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus()
  }
  return (
    <span ref={group} id={id} role="radiogroup" aria-label={ariaLabel} aria-describedby={describedBy}
      aria-disabled={disabled || undefined} className="st-seg" data-control="segmented"
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(null) }}>
      {options.map((o, i) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} tabIndex={i === stop ? 0 : -1}
          className={'st-seg-option' + (o.value === value ? ' is-active' : '')} disabled={disabled}
          onFocus={() => setFocused(i)}
          onClick={() => pick(i)} onKeyDown={(e) => keys(e, i)}>
          {o.glyph ? <span className="st-seg-glyph" aria-hidden="true">{o.glyph}</span> : null}
          {o.label}
        </button>
      ))}
    </span>
  )
}

/** A titled group of rows: secondary heading above a bordered card, hairline dividers between rows. */
export function SettingsGroup({ title, description, children }: {
  title?: string
  description?: string
  children: React.ReactNode
}): React.JSX.Element {
  const headingId = useId()
  return (
    <section className="st-group" data-slot="settings-group" aria-labelledby={title ? headingId : undefined}>
      {title ? <h3 id={headingId} className="st-group-title">{title}</h3> : null}
      {description ? <p className="st-group-desc">{description}</p> : null}
      <div className="st-group-card">{children}</div>
    </section>
  )
}

export const ADVANCED_SUMMARY = (count: number): string => (count ? `Advanced · ${count}` : 'Advanced')

/** The one "Advanced" collapsible of a page (closed by default; a link to a field inside opens it). A
 *  `<details>` so the reveal path opens it; the browser triangle is replaced by a codicon chevron. */
export function SettingsAdvanced({ count, children }: { count?: number; children: React.ReactNode }): React.JSX.Element {
  const n = count ?? Children.toArray(children).length
  return (
    <details className="st-advanced" data-slot="settings-advanced">
      <summary className="st-advanced-summary">
        <span className="codicon codicon-chevron-right st-advanced-chevron" aria-hidden="true" />
        {ADVANCED_SUMMARY(n)}
      </summary>
      <div className="st-group-card">{children}</div>
    </details>
  )
}
