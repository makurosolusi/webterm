// "Custom command" mode of the Claude provider card (optional): Claude runs through the user's own command,
// e.g. a wrapper such as `op run -- claude`, `doppler run -- claude` or `envman -e x -- claude`, which injects
// the credential itself. No wrapper is privileged: detection only lists what is installed, as a hint. The command is stored as
// a Claude launch profile (Settings > Agent), the same list that page edits; this form only creates or
// picks one, then the card points the provider at it (PUT {mode:'command', profileId}).
import { useEffect, useState, type MutableRefObject } from 'react'
import { Badge } from '@/components/ui/badge'
import { ActionButton, useAction } from '@/components/ui/action'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { SettingsSelect } from './SettingsControls'
import { Field } from './SettingsFieldRow'
import { SettingsMessage } from './SettingsMessage'
import { CLAUDE_PROFILE_LIMITS, type ClaudeLaunchProfile } from '../shared/claudeLaunch/claudeLaunch.profiles'
import { normalizeClaudeCommand, splitLaunch } from '../shared/claudeLaunch/claudeLaunch.normalize'
import { joinArgv } from '../shared/claudeLaunch/shellQuote'
import { detectWrappers, loadLaunchProfiles, upsertLaunchProfile, type DetectedWrapper, type ProviderView } from './claudeProvider.api'

export const COMMAND_TEXT = {
  saved: 'Saved commands',
  savedHint: 'Pick one you saved before, or start a new one.',
  newCommand: 'New command…',
  command: 'Launch command',
  name: 'Command name',
  nameHint: 'Shown in the list of saved commands.',
  placeholder: 'your-wrapper … -- claude',
  wrapper: (w: string): string => `wrapper: ${w}`,
  detected: (names: string[]): string => `Detected on this machine: ${names.join(', ')}`,
  note: 'Your command supplies the credential; webterm adds none. End it with "--" and claude is added for you.',
  willRun: 'Runs:',
  applyFix: 'Apply fix',
  secret: 'This command looks like it contains a key. Prefer a wrapper such as op run, doppler run or envman so the secret stays out of webterm settings.',
  missing: 'The selected command was removed. Pick another or create a new one.',
  save: 'Save',
  saving: 'Saving…',
  clean: 'Saved',
  noChanges: 'No changes to save',
  needCommand: 'Enter the command first.',
  testing: 'Testing…',
  loadFailed: 'Could not load the saved commands.',
  saveFailed: (code: string): string => `Could not save the command (${code}).`,
  fallbackName: 'Custom command',
}

const NEW = '' // `selected` while no saved command is picked

const baseName = (t: string): string => t.slice(t.lastIndexOf('/') + 1)
const wrapperOf = (command: string): string | null => {
  const w = splitLaunch(normalizeClaudeCommand(command).argv).wrapper
  return w.length > 0 ? baseName(w[0] as string) : null
}
/** "<wrapper>: <target>" (e.g. "envman: claude:malik-opus") from the wrapper and its `-e` target; "" for an empty command. */
export function commandName(command: string): string {
  if (command.trim() === '') return ''
  const w = splitLaunch(normalizeClaudeCommand(command).argv).wrapper
  if (w.length === 0) return COMMAND_TEXT.fallbackName
  const at = w.findIndex((t) => t === '-e' || t === '--env')
  const target = at >= 0 ? w[at + 1] : undefined
  return target ? `${baseName(w[0] as string)}: ${target}` : baseName(w[0] as string)
}

export interface ClaudeProviderCommandProps {
  provider: ProviderView
  busy: boolean
  /** Test connection / Testing… / Test again (the card owns the test). */
  testLabel: string
  /** Point the provider at the profile (the card's PUT); true = saved. */
  commit(profileId: string): Promise<boolean>
  /** Probe the saved provider (no save first: this form already saved). */
  test(): Promise<void>
  /** A save failed here (the profile write): the card toasts it. */
  /** A failed save; `retry` saves the same draft again. */
  onError?(message: string, retry: () => void): void
  /** Filled with this form's save while it has unsaved edits, null when clean (wizard Continue). */
  pending?: MutableRefObject<(() => Promise<boolean>) | null>
  /** The host saves through `pending`, so no Save button here. */
  hideSave?: boolean
}

export function ClaudeProviderCommand(p: ClaudeProviderCommandProps): React.JSX.Element {
  const { provider } = p
  const start = provider.mode === 'command' && !provider.profileMissing ? provider.profile : undefined
  const [profiles, setProfiles] = useState<ClaudeLaunchProfile[]>([])
  const [wrappers, setWrappers] = useState<DetectedWrapper[]>([])
  const [selected, setSelected] = useState(start?.id ?? NEW)
  const [command, setCommand] = useState(start?.command ?? '')
  const [name, setName] = useState(start?.name ?? '')
  const [nameTouched, setNameTouched] = useState(start !== undefined)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadLaunchProfiles().then(setProfiles).catch(() => setError(COMMAND_TEXT.loadFailed))
    detectWrappers().then(setWrappers).catch(() => setWrappers([])) // detection is a convenience: no hint when it fails
  }, [])

  const shownName = nameTouched ? name : commandName(command)
  const n = normalizeClaudeCommand(command)
  const wrapper = wrapperOf(command)
  const installed = wrappers.filter((w) => w.installed).map((w) => w.name)
  const stored = profiles.find((x) => x.id === selected) ?? (provider.profile?.id === selected ? provider.profile : undefined)
  const clean = provider.mode === 'command' && provider.profileId === selected && stored !== undefined
    && stored.command === command.trim() && stored.name === (shownName.trim() || COMMAND_TEXT.fallbackName)
  const disabled = p.busy || working

  const pick = (x: ClaudeLaunchProfile | null): void => {
    setSelected(x?.id ?? NEW); setCommand(x?.command ?? ''); setName(x?.name ?? ''); setNameTouched(x !== null)
  }
  /** Create/update the profile, then point the provider at it. */
  const saveDraft = async (): Promise<boolean> => {
    setWorking(true); setError(null)
    try {
      const r = await upsertLaunchProfile({ id: selected === NEW ? null : selected, name: shownName.trim() || COMMAND_TEXT.fallbackName, command })
      setProfiles(r.profiles); setSelected(r.id); setName(r.profiles.find((x) => x.id === r.id)?.name ?? ''); setNameTouched(true)
      return await p.commit(r.id)
    } catch (e) {
      const message = COMMAND_TEXT.saveFailed(e instanceof Error ? e.message : 'error')
      setError(message); p.onError?.(message, () => { void saveDraft() })
      return false
    } finally { setWorking(false) }
  }
  useEffect(() => {
    if (p.pending) p.pending.current = clean || command.trim() === '' ? null : saveDraft
  })
  const runTest = async (): Promise<void> => {
    if (!clean && !(await saveDraft())) return
    await p.test()
  }

  const empty = command.trim() === ''
  // Busy per button; the inline error (and the card's toast with Retry) is the failure surface.
  const saveAct = useAction(saveDraft, { label: COMMAND_TEXT.save, ok: (r) => r, toast: 'never', minBusyMs: 0 })
  const testAct = useAction(runTest, { label: p.testLabel, toast: 'never', minBusyMs: 0 })

  const commandId = 'st-claude-command'
  const pickerOptions = [...profiles.map((x) => ({ value: x.id, label: x.name })), { value: NEW, label: COMMAND_TEXT.newCommand }]
  return (
    <div className="contents" data-card="claude-provider-command">
      {provider.mode === 'command' && provider.profileMissing ? <SettingsMessage kind="warning">{COMMAND_TEXT.missing}</SettingsMessage> : null}
      {error ? <SettingsMessage kind="error">{error}</SettingsMessage> : null}
      {profiles.length > 0 ? (
        <Field label={COMMAND_TEXT.saved} hint={COMMAND_TEXT.savedHint} htmlFor="st-claude-command-pick">
          <SettingsSelect id="st-claude-command-pick" value={selected} options={pickerOptions}
            onChange={(id) => pick(profiles.find((x) => x.id === id) ?? null)} />
        </Field>
      ) : null}
      <Field label={COMMAND_TEXT.command} hint={COMMAND_TEXT.note} htmlFor={commandId} block>
        <Input id={commandId} className="st-input st-mono st-input-wide" aria-label={COMMAND_TEXT.command} placeholder={COMMAND_TEXT.placeholder} value={command}
          maxLength={CLAUDE_PROFILE_LIMITS.command} spellCheck={false} autoComplete="off" onChange={(e) => setCommand(e.target.value)} />
        {wrapper !== null || installed.length > 0 ? (
          <span className="flex flex-wrap items-center gap-2">
            {wrapper !== null ? <Badge variant="secondary">{COMMAND_TEXT.wrapper(wrapper)}</Badge> : null}
            {installed.length > 0 ? <span className="st-hint">{COMMAND_TEXT.detected(installed)}</span> : null}
          </span>
        ) : null}
        {command.trim() !== '' ? <p className="st-hint m-0"><span>{COMMAND_TEXT.willRun}</span> <code className="st-mono">{joinArgv(n.argv)}</code></p> : null}
        {n.warnings.length > 0 ? (
          <span role="status" className="flex flex-wrap items-center gap-2 text-xs text-(--vscode-editorWarning-foreground)">
            {n.warnings.map((w) => <span key={w}>{w}</span>)}
            {n.suggestion !== undefined ? <Button size="xs" variant="secondary" onClick={() => setCommand(n.suggestion as string)}>{COMMAND_TEXT.applyFix}</Button> : null}
          </span>
        ) : null}
        {provider.mode === 'command' && provider.commandWarning === 'looks_like_secret' ? <p role="status" className="st-hint st-hint--warning m-0">{COMMAND_TEXT.secret}</p> : null}
      </Field>
      <Field label={COMMAND_TEXT.name} hint={COMMAND_TEXT.nameHint} htmlFor="st-claude-command-name">
        <Input id="st-claude-command-name" className="st-input st-input-wide" aria-label={COMMAND_TEXT.name} value={shownName} maxLength={CLAUDE_PROFILE_LIMITS.name}
          onChange={(e) => { setName(e.target.value); setNameTouched(true) }} />
      </Field>
      <div className="st-actions">
        <span className="st-actions-status" />
        <ActionButton variant="outline" size="sm" disabled={disabled} action={testAct} busyLabel={working ? COMMAND_TEXT.saving : p.testLabel}
          lock={empty ? { reason: COMMAND_TEXT.needCommand } : undefined}>{p.testLabel}</ActionButton>
        {p.hideSave ? null : (
          <IconTooltip label={working ? COMMAND_TEXT.saving : clean ? COMMAND_TEXT.clean : COMMAND_TEXT.save} disabled={disabled || empty || clean}
            disabledReason={working ? undefined : empty ? COMMAND_TEXT.needCommand : clean ? COMMAND_TEXT.noChanges : undefined}>
            <ActionButton size="sm" disabled={disabled || empty || clean} action={saveAct} busyLabel={COMMAND_TEXT.saving}>
              {working ? COMMAND_TEXT.saving : clean ? COMMAND_TEXT.clean : COMMAND_TEXT.save}</ActionButton>
          </IconTooltip>
        )}
      </div>
    </div>
  )
}
