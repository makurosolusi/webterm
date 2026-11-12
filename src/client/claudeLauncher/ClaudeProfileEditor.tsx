// Inline add/edit form for one Claude launch profile: name, command (combobox: templates + recent), a live
// "Will run:" preview from the same normaliser the server launches with, typo fixes, validation.
// Nothing is stored until Save. Escape cancels. The pattern follows VS Code's settings list editor.
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { normalizeClaudeCommand } from '../../shared/claudeLaunch/claudeLaunch.normalize'
import { CLAUDE_PROFILE_LIMITS, type ClaudeLaunchProfile } from '../../shared/claudeLaunch/claudeLaunch.profiles'
import { hasUnclosedQuote, joinArgv } from '../../shared/claudeLaunch/shellQuote'
import { SettingsCombobox } from '../SettingsCombobox'

export const EDITOR_TEXT = {
  addTitle: 'New launch profile',
  editTitle: (name: string): string => `Edit ${name}`,
  name: 'Name',
  namePlaceholder: 'e.g. Malik (Opus)',
  command: 'Launch command',
  commandPlaceholder: 'envman -e claude:my-account --',
  presets: 'Templates',
  willRun: 'Will run:',
  applyFix: 'Apply fix',
  save: 'Save',
  cancel: 'Cancel',
  nameRequired: 'Enter a name.',
  nameTaken: 'A profile with this name already exists.',
  commandRequired: 'Enter the command that starts Claude.',
  unclosedQuote: 'A quote is not closed.',
  placeholderLeft: (p: string): string => `Replace ${p} with your own value.`,
}

/** Command templates (combobox suggestions): `select` is the part the user is expected to type over. */
export const PRESETS: readonly { label: string; text: string; select: string }[] = [
  { label: 'Wrapper ending in --', text: '<wrapper> --', select: '<wrapper>' },
  { label: 'Custom claude path', text: '/path/to/claude', select: '/path/to' },
  { label: 'Extra flags', text: 'claude --model opus', select: 'opus' },
]

export interface ProfileDraft { name: string; command: string }

/** The command's error sentence, or null. */
export function validateProfileCommand(command: string): string | null {
  const placeholder = /<[A-Za-z-]+>/.exec(command)?.[0]
  if (!command.trim()) return EDITOR_TEXT.commandRequired
  if (hasUnclosedQuote(command)) return EDITOR_TEXT.unclosedQuote
  return placeholder ? EDITOR_TEXT.placeholderLeft(placeholder) : null
}

/** Errors per field; empty object = savable. `taken` = names of the OTHER profiles (Default included). */
export function validateProfileDraft(d: ProfileDraft, taken: readonly string[]): { name?: string; command?: string } {
  const out: { name?: string; command?: string } = {}
  const name = d.name.trim()
  if (!name) out.name = EDITOR_TEXT.nameRequired
  else if (taken.some((t) => t.trim().toLowerCase() === name.toLowerCase())) out.name = EDITOR_TEXT.nameTaken
  const command = validateProfileCommand(d.command)
  if (command) out.command = command
  return out
}

export function ClaudeProfileEditor({ profile, taken, onSave, onCancel }: {
  /** undefined = a new profile. */
  profile?: ClaudeLaunchProfile
  taken: readonly string[]
  onSave(draft: ProfileDraft): void
  onCancel(): void
}): React.JSX.Element {
  const [draft, setDraft] = useState<ProfileDraft>({ name: profile?.name ?? '', command: profile?.command ?? '' })
  // Errors show once a field was touched or Save was tried, not while the form is still blank.
  const [touched, setTouched] = useState({ name: false, command: false })
  const nameRef = useRef<HTMLInputElement>(null)
  const commandRef = useRef<HTMLInputElement>(null)
  const pendingSelect = useRef<string | null>(null)
  useEffect(() => { nameRef.current?.focus() }, [])
  useEffect(() => {
    const el = commandRef.current
    const sel = pendingSelect.current
    if (!el || sel === null) return
    pendingSelect.current = null
    const at = draft.command.indexOf(sel)
    el.focus()
    if (at >= 0) el.setSelectionRange(at, at + sel.length)
  }, [draft.command])

  const errors = validateProfileDraft(draft, taken)
  const valid = !errors.name && !errors.command
  const n = normalizeClaudeCommand(draft.command)
  const id = profile?.id ?? 'new'
  const show = (k: 'name' | 'command'): string | undefined => (touched[k] ? errors[k] : undefined)
  const save = (): void => {
    setTouched({ name: true, command: true })
    if (valid) onSave({ name: draft.name.trim(), command: draft.command.trim() })
  }
  const setCommand = (command: string): void => setDraft((d) => ({ ...d, command }))
  const onDraft = (command: string): void => {
    const preset = PRESETS.find((p) => p.text === command)
    if (preset) { pendingSelect.current = preset.select; setTouched((t) => ({ ...t, command: true })) }
    setCommand(command)
  }

  return (
    <form className="st-profile st-profile--editing" data-settings-escape aria-label={profile ? EDITOR_TEXT.editTitle(profile.name) : EDITOR_TEXT.addTitle}
      onSubmit={(e) => { e.preventDefault(); save() }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel() } }}>
      <label className="st-profile-label" htmlFor={`cp-name-${id}`}>{EDITOR_TEXT.name}</label>
      <Input ref={nameRef} id={`cp-name-${id}`} className="st-input" value={draft.name} maxLength={CLAUDE_PROFILE_LIMITS.name}
        placeholder={EDITOR_TEXT.namePlaceholder} aria-invalid={!!show('name')} aria-describedby={show('name') ? `cp-name-err-${id}` : undefined}
        onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} onBlur={() => setTouched((t) => ({ ...t, name: true }))} />
      {show('name') ? <p id={`cp-name-err-${id}`} className="st-profile-error">{show('name')}</p> : null}

      <label className="st-profile-label" htmlFor={`cp-cmd-${id}`}>{EDITOR_TEXT.command}</label>
      <span className="st-profile-combo" onBlur={() => setTouched((t) => ({ ...t, command: true }))}>
        <SettingsCombobox inputRef={commandRef} id={`cp-cmd-${id}`} fieldId="claude.profileCommand" mono value={draft.command}
          presets={PRESETS.map((p) => ({ value: p.text, label: p.label }))} placeholder={EDITOR_TEXT.commandPlaceholder}
          maxLength={CLAUDE_PROFILE_LIMITS.command} validate={validateProfileCommand} error={show('command')}
          onDraft={onDraft} onCommit={setCommand} />
      </span>

      <p className="st-profile-preview" aria-live="polite"><span>{EDITOR_TEXT.willRun}</span> <code className="st-mono" data-testid="cp-preview">{joinArgv(n.argv)}</code></p>
      {n.warnings.length > 0 ? (
        <div role="status" className="flex flex-wrap items-center gap-2 text-xs text-(--vscode-editorWarning-foreground)">
          {n.warnings.map((w) => <span key={w}>{w}</span>)}
          {n.suggestion !== undefined ? (
            <Button type="button" size="xs" variant="secondary" onClick={() => setCommand(n.suggestion as string)}>{EDITOR_TEXT.applyFix}</Button>
          ) : null}
        </div>
      ) : null}
      <div className="flex gap-2">
        {/* Disabled Save says what is missing on hover/focus; the field errors stay quiet until touched. */}
        <IconTooltip label={EDITOR_TEXT.save} disabled={!valid} disabledReason={errors.name ?? errors.command}>
          <Button type="submit" size="sm" disabled={!valid}>{EDITOR_TEXT.save}</Button>
        </IconTooltip>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>{EDITOR_TEXT.cancel}</Button>
      </div>
    </form>
  )
}
