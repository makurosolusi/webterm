// "Custom command" mode of the Claude provider card: Claude runs through the user's own command, e.g.
// `envman -e claude:malik-opus -- claude`, which injects the credential itself. The command is stored as
// a Claude launch profile (Settings > Agent), the same list that page edits; this form only creates or
// picks one, then the card points the provider at it (PUT {mode:'command', profileId}).
import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { CLAUDE_PROFILE_LIMITS, type ClaudeLaunchProfile } from '../shared/claudeLaunch/claudeLaunch.profiles'
import { normalizeClaudeCommand, splitLaunch } from '../shared/claudeLaunch/claudeLaunch.normalize'
import { joinArgv } from '../shared/claudeLaunch/shellQuote'
import { detectWrappers, loadLaunchProfiles, upsertLaunchProfile, type DetectedWrapper, type ProviderView } from './claudeProvider.api'

export const COMMAND_TEXT = {
  saved: 'Saved commands',
  newCommand: 'New command…',
  command: 'Launch command',
  name: 'Command name',
  placeholder: 'envman -e myapp:prod -- claude',
  wrapper: (w: string): string => `wrapper: ${w}`,
  template: 'Use envman template',
  note: 'webterm leaves credentials alone in this mode; your command supplies them.',
  willRun: 'Runs:',
  applyFix: 'Apply fix',
  secret: 'This command looks like it contains a key. Prefer a wrapper such as envman so the secret stays out of webterm settings.',
  missing: 'The selected command was removed. Pick another or create a new one.',
  save: 'Save',
  saving: 'Saving…',
  clean: 'Saved',
  noChanges: 'No changes to save',
  loadFailed: 'Could not load the saved commands.',
  saveFailed: (code: string): string => `Could not save the command (${code}).`,
  fallbackName: 'Custom command',
}

const PLACEHOLDER = 'project:env'
const TEMPLATE = `envman -e ${PLACEHOLDER} -- claude`
const NEW = '' // `selected` while no saved command is picked

const baseName = (t: string): string => t.slice(t.lastIndexOf('/') + 1)
const wrapperOf = (command: string): string | null => {
  const w = splitLaunch(normalizeClaudeCommand(command).argv).wrapper
  return w.length > 0 ? baseName(w[0] as string) : null
}
/** "envman: claude:malik-opus" from the wrapper and its `-e` target; "" for an empty command. */
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
  onError?(message: string): void
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
  const input = useRef<HTMLInputElement>(null)
  const selectPlaceholder = useRef(false)

  useEffect(() => {
    loadLaunchProfiles().then(setProfiles).catch(() => setError(COMMAND_TEXT.loadFailed))
    detectWrappers().then(setWrappers).catch(() => setWrappers([])) // detection is a convenience: no templates when it fails
  }, [])
  useLayoutEffect(() => {
    if (!selectPlaceholder.current) return
    selectPlaceholder.current = false
    const at = command.indexOf(PLACEHOLDER)
    if (input.current && at >= 0) { input.current.focus(); input.current.setSelectionRange(at, at + PLACEHOLDER.length) }
  }, [command])

  const shownName = nameTouched ? name : commandName(command)
  const n = normalizeClaudeCommand(command)
  const wrapper = wrapperOf(command)
  const envman = wrappers.some((w) => w.name === 'envman' && w.installed)
  const stored = profiles.find((x) => x.id === selected) ?? (provider.profile?.id === selected ? provider.profile : undefined)
  const clean = provider.mode === 'command' && provider.profileId === selected && stored !== undefined
    && stored.command === command.trim() && stored.name === (shownName.trim() || COMMAND_TEXT.fallbackName)
  const disabled = p.busy || working

  const pick = (x: ClaudeLaunchProfile | null): void => {
    setSelected(x?.id ?? NEW); setCommand(x?.command ?? ''); setName(x?.name ?? ''); setNameTouched(x !== null)
  }
  const useTemplate = (): void => {
    pick(null); setCommand(TEMPLATE); selectPlaceholder.current = true
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
      setError(message); p.onError?.(message)
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

  return (
    <div className="flex flex-col gap-2" data-card="claude-provider-command">
      {provider.mode === 'command' && provider.profileMissing ? <p role="alert" className="text-xs text-amber-600">{COMMAND_TEXT.missing}</p> : null}
      {profiles.length > 0 ? (
        <div role="group" aria-label={COMMAND_TEXT.saved} className="flex flex-wrap gap-1">
          {profiles.map((x) => (
            <Button key={x.id} size="sm" variant={selected === x.id ? 'default' : 'outline'} aria-pressed={selected === x.id} onClick={() => pick(x)}>{x.name}</Button>
          ))}
          <Button size="sm" variant={selected === NEW ? 'default' : 'outline'} aria-pressed={selected === NEW} onClick={() => pick(null)}>{COMMAND_TEXT.newCommand}</Button>
        </div>
      ) : null}
      <Input ref={input} className="st-mono" aria-label={COMMAND_TEXT.command} placeholder={COMMAND_TEXT.placeholder} value={command}
        maxLength={CLAUDE_PROFILE_LIMITS.command} spellCheck={false} autoComplete="off" onChange={(e) => setCommand(e.target.value)} />
      {wrapper !== null || envman ? (
        <div className="flex flex-wrap items-center gap-2">
          {wrapper !== null ? <Badge variant="secondary">{COMMAND_TEXT.wrapper(wrapper)}</Badge> : null}
          {envman ? <Button size="xs" variant="secondary" onClick={useTemplate}>{COMMAND_TEXT.template}</Button> : null}
        </div>
      ) : null}
      <Input aria-label={COMMAND_TEXT.name} value={shownName} maxLength={CLAUDE_PROFILE_LIMITS.name}
        onChange={(e) => { setName(e.target.value); setNameTouched(true) }} />
      {command.trim() !== '' ? <p className="m-0 text-xs opacity-70"><span>{COMMAND_TEXT.willRun}</span> <code className="st-mono">{joinArgv(n.argv)}</code></p> : null}
      {n.warnings.length > 0 ? (
        <div role="status" className="flex flex-wrap items-center gap-2 text-xs text-amber-600">
          {n.warnings.map((w) => <span key={w}>{w}</span>)}
          {n.suggestion !== undefined ? <Button size="xs" variant="secondary" onClick={() => setCommand(n.suggestion as string)}>{COMMAND_TEXT.applyFix}</Button> : null}
        </div>
      ) : null}
      {provider.mode === 'command' && provider.commandWarning === 'looks_like_secret' ? <p role="status" className="text-xs text-amber-600">{COMMAND_TEXT.secret}</p> : null}
      <p className="text-xs opacity-70">{COMMAND_TEXT.note}</p>
      <div className="flex items-center gap-2">
        {p.hideSave ? null : (
          <IconTooltip label={working ? COMMAND_TEXT.saving : clean ? COMMAND_TEXT.clean : COMMAND_TEXT.save} disabled={disabled || command.trim() === '' || clean}
            disabledReason={clean && !working ? COMMAND_TEXT.noChanges : undefined}>
            <Button size="sm" disabled={disabled || command.trim() === '' || clean} aria-busy={working}
              onClick={() => void saveDraft()}>{working ? COMMAND_TEXT.saving : clean ? COMMAND_TEXT.clean : COMMAND_TEXT.save}</Button>
          </IconTooltip>
        )}
        <Button variant="outline" size="sm" disabled={disabled || command.trim() === ''} onClick={() => void runTest()}>{p.testLabel}</Button>
      </div>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </div>
  )
}
