// "Claude launch profiles" (Settings > Claude, under Connection): how webterm starts Claude, e.g.
// `envman -e claude:malik-opus -- claude`. A list like VS Code's settings list editor: the built-in
// Default (`claude`, read-only) first, then the user's profiles with their resolved command, badges
// and Edit / Test / Delete. The badges come from the server's resolver (GET /api/claude-launch/effective), so
// the command-mode default is shown where launches really go; without it they fall back to the stored keys. Add and Edit open ClaudeProfileEditor inline; Test probes the SAVED profile.
// Saves patch only the changed profile (the server merges by id); Delete is an awaited server call so a
// refusal (the profile is still in use) is shown on the row.
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ActionButton, ActionResult, errorCause, useAction } from '@/components/ui/action'
import { IconTooltip } from '@/components/ui/icon-button'
import type { Settings } from '../../shared/settings'
import { joinArgv } from '../../shared/claudeLaunch/shellQuote'
import {
  DEFAULT_CLAUDE_PROFILE, centralProfileId, claudeProfiles, resolveProfileLaunch, type ClaudeLaunchProfile,
} from '../../shared/claudeLaunch/claudeLaunch.profiles'
import { Field, SelectField } from '../SettingsFields'
import type { EffectiveClaudeLaunch } from '../../shared/claudeLaunch/claudeLaunch.effective'
import { randomId } from '../randomId'
import { deleteLaunchProfile, ProfileInUseError } from '../claudeProvider.api'
import type { ProfileInUse } from '../../shared/settings.patch'
import { testClaudeLaunch, type LaunchTest } from './claudeLaunch.client'
import { ClaudeProfileEditor, type ProfileDraft } from './ClaudeProfileEditor'
import { LaunchSteps } from './LaunchSteps'
import { profileInUseMessage } from './profileInUse.text'

type LaunchSettings = Pick<Settings, 'claudeLaunchProfiles' | 'defaultClaudeProfileId' | 'centralClaudeProfileId'>

export const PROFILES_TEXT = {
  title: 'Claude launch profiles',
  hint: 'How webterm starts Claude. Use a wrapper that injects env vars, e.g. envman -e claude:malik-opus -- claude. '
    + 'Ending with "--" is enough; claude is added for you. Flags after claude (--model …) are kept.',
  empty: 'A profile is a named command that starts Claude, for example through a wrapper that picks an account. Without one, webterm runs plain claude.',
  add: 'Add profile',
  edit: 'Edit',
  test: 'Test',
  testing: 'Testing…',
  remove: 'Delete',
  confirmRemove: (name: string): string => `Delete "${name}"?`,
  builtIn: 'Built in',
  badgeDefault: 'Default for new agents',
  badgeCentral: 'Central',
  saved: (name: string): string => `Saved "${name}".`,
  useForCentral: 'Use for Central',
  dismiss: 'Dismiss',
  cancel: 'Cancel',
  /** Central's own pick (Settings › Claude › Advanced). */
  sameAsDefault: 'Same as new Claude agents',
  centralUses: 'Central uses',
  centralUsesHint: 'Which launch profile starts Central. Usually the same as new agents.',
  testFailed: (code: string): string => `Test could not run (${code}). Save, then try again.`,
  removing: 'Deleting…',
  testPassed: 'Every check passed.',
  testProblem: 'A check failed; see the steps below.',
  addLocked: 'Save or cancel the open profile first.',
  inUse: (name: string, reason: ProfileInUse): string => profileInUseMessage(name, reason),
  removeFailed: (name: string, code: string): string => `Could not delete "${name}" (${code}).`,
}

const describe = (p: ClaudeLaunchProfile): string => (p.id === DEFAULT_CLAUDE_PROFILE.id ? `${p.name} (claude)` : p.name)
/** What a profile runs, from the same resolver the server launches with. */
const preview = (s: LaunchSettings, id: string): string => joinArgv(resolveProfileLaunch(s, id).argv)

const profileOptions = (s: LaunchSettings): { value: string; label: string }[] => claudeProfiles(s).map((p) => ({ value: p.id, label: describe(p) }))

/** The card; settings + onChange come from the Claude section (patches are saved by useSettings). `effective` = server truth for the badges. */
export function ClaudeLaunchProfilesCard({ settings: s, onChange, effective }: { settings: LaunchSettings; onChange(patch: Partial<Settings>): void; effective?: EffectiveClaudeLaunch | null }): React.JSX.Element {
  const all = claudeProfiles(s)
  // 'new' = the Add form; a profile id = that profile's Edit form.
  const [editing, setEditing] = useState<string | null>(null)
  const [justSaved, setJustSaved] = useState<string | null>(null)
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focusKey === null) return
    listRef.current?.querySelector<HTMLElement>(`[data-focus-key="${focusKey}"]`)?.focus()
    setFocusKey(null)
  }, [focusKey])

  // The server's answer (command mode included); before it arrives, the stored keys resolved the same way.
  const defaultId = effective?.agents.profileId ?? resolveProfileLaunch(s).profile.id
  const centralId = effective?.central.profileId ?? resolveProfileLaunch(s, centralProfileId(s)).profile.id
  const close = (key: string): void => { setEditing(null); setFocusKey(key) }
  const save = (id: string | null, d: ProfileDraft): void => {
    const old = s.claudeLaunchProfiles.find((p) => p.id === id)
    if (old) onChange({ claudeLaunchProfiles: [{ ...old, ...d }] })
    else {
      const created = { id: randomId(), ...d }
      onChange({ claudeLaunchProfiles: [created] })
      setJustSaved(created.id)
    }
    close(id ? `edit-${id}` : 'add')
  }
  /** Throws on refusal; the row's Delete action shows why. */
  const remove = async (p: ClaudeLaunchProfile): Promise<void> => {
    // Never leave a pointer at a deleted profile: it would silently fall back at the next launch.
    await deleteLaunchProfile(p.id, {
      ...(s.defaultClaudeProfileId === p.id ? { defaultClaudeProfileId: DEFAULT_CLAUDE_PROFILE.id } : {}),
      ...(s.centralClaudeProfileId === p.id ? { centralClaudeProfileId: '' } : {}),
    })
    setFocusKey('add')
  }
  const takenBy = (id: string | null): string[] => all.filter((p) => p.id !== id).map((p) => p.name)
  return (
      <Field label={PROFILES_TEXT.title} hint={PROFILES_TEXT.hint} setting="claudeLaunchProfiles" block>
        <div ref={listRef} className="flex flex-col gap-2" data-card="claude-launch-profiles">
          {all.map((p) => (editing === p.id
            ? <ClaudeProfileEditor key={p.id} profile={p} taken={takenBy(p.id)} onSave={(d) => save(p.id, d)} onCancel={() => close(`edit-${p.id}`)} />
            : <ProfileRow key={p.id} profile={p} command={preview(s, p.id)} isDefault={defaultId === p.id} isCentral={centralId === p.id}
                onEdit={() => setEditing(p.id)} onRemove={() => remove(p)}
                saved={justSaved === p.id ? {
                  useForCentral: () => { onChange({ centralClaudeProfileId: p.id }) },
                  dismiss: () => setJustSaved(null),
                } : undefined} />))}
          {s.claudeLaunchProfiles.length === 0 && editing !== 'new' ? <p className="st-hint m-0">{PROFILES_TEXT.empty}</p> : null}
          {editing === 'new'
            ? <ClaudeProfileEditor taken={takenBy(null)} onSave={(d) => save(null, d)} onCancel={() => close('add')} />
            : <IconTooltip label={PROFILES_TEXT.add} disabled={editing !== null} disabledReason={PROFILES_TEXT.addLocked}>
                <Button size="sm" variant="secondary" className="self-start" data-focus-key="add" disabled={editing !== null}
                  onClick={() => { setJustSaved(null); setEditing('new') }}>{PROFILES_TEXT.add}</Button>
              </IconTooltip>}
        </div>
      </Field>
  )
}

/** "Central uses" (Settings › Claude › Advanced): Central's own profile; '' = the same as new agents. */
export function CentralProfileField({ settings: s, onChange }: { settings: LaunchSettings; onChange(patch: Partial<Settings>): void }): React.JSX.Element {
  const current = claudeProfiles(s).some((p) => p.id === s.centralClaudeProfileId) ? s.centralClaudeProfileId : ''
  return (
    <SelectField id="st-centralClaudeProfileId" setting="centralClaudeProfileId" label={PROFILES_TEXT.centralUses} hint={PROFILES_TEXT.centralUsesHint}
      value={current} options={[{ value: '', label: PROFILES_TEXT.sameAsDefault }, ...profileOptions(s)]} onChange={(v) => onChange({ centralClaudeProfileId: v })} />
  )
}

function ProfileRow({ profile: p, command, isDefault, isCentral, onEdit, onRemove, saved }: {
  profile: ClaudeLaunchProfile
  command: string
  isDefault: boolean
  isCentral: boolean
  onEdit(): void
  onRemove(): Promise<void>
  saved?: { useForCentral(): void; dismiss(): void }
}): React.JSX.Element {
  const [test, setTest] = useState<LaunchTest | null>(null)
  const [confirming, setConfirming] = useState(false)
  const builtIn = p.id === DEFAULT_CLAUDE_PROFILE.id
  const testAction = useAction(async () => {
    setTest(null)
    const r = await testClaudeLaunch({ profileId: p.id })
    setTest(r)
    return r
  }, {
    label: PROFILES_TEXT.test, ok: (r) => r.ok, success: (r) => (r.ok ? PROFILES_TEXT.testPassed : PROFILES_TEXT.testProblem),
    failure: (e) => PROFILES_TEXT.testFailed(errorCause(e)),
  })
  const removeAction = useAction(onRemove, {
    label: PROFILES_TEXT.remove,
    failure: (e) => (e instanceof ProfileInUseError ? PROFILES_TEXT.inUse(p.name, e.reason) : PROFILES_TEXT.removeFailed(p.name, errorCause(e))),
  })
  return (
    <section className="st-profile" aria-label={p.name} data-profile={p.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="st-profile-name">{p.name}</span>
        {builtIn ? <span className="st-profile-badge">{PROFILES_TEXT.builtIn}</span> : null}
        {isDefault ? <span className="st-profile-badge">{PROFILES_TEXT.badgeDefault}</span> : null}
        {isCentral ? <span className="st-profile-badge">{PROFILES_TEXT.badgeCentral}</span> : null}
        <span className="flex-1" />
        {builtIn ? null : <Button size="xs" variant="ghost" data-focus-key={`edit-${p.id}`} onClick={onEdit}>{PROFILES_TEXT.edit}</Button>}
        <ActionButton size="xs" variant="outline" action={testAction} busyLabel={PROFILES_TEXT.testing}>{PROFILES_TEXT.test}</ActionButton>
        {builtIn ? null : <Button size="xs" variant="ghost" onClick={() => setConfirming(true)}>{PROFILES_TEXT.remove}</Button>}
      </div>
      <code className="st-mono st-profile-command">{command}</code>
      {confirming ? (
        <div role="alertdialog" aria-label={PROFILES_TEXT.confirmRemove(p.name)} className="flex flex-wrap items-center gap-2 text-xs">
          <span>{PROFILES_TEXT.confirmRemove(p.name)}</span>
          <ActionButton size="xs" variant="destructive" autoFocus action={removeAction} busyLabel={PROFILES_TEXT.removing}>{PROFILES_TEXT.remove}</ActionButton>
          <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>{PROFILES_TEXT.cancel}</Button>
        </div>
      ) : null}
      {saved ? (
        <div role="status" className="flex flex-wrap items-center gap-2 text-xs">
          <span>{PROFILES_TEXT.saved(p.name)}</span>
          {isCentral ? null : <Button size="xs" variant="secondary" onClick={saved.useForCentral}>{PROFILES_TEXT.useForCentral}</Button>}
          <Button size="xs" variant="ghost" onClick={saved.dismiss}>{PROFILES_TEXT.dismiss}</Button>
        </div>
      ) : null}
      <ActionResult action={testAction} stamp="tested" />
      {test ? <LaunchSteps steps={test.steps} /> : null}
      <ActionResult action={removeAction} />
    </section>
  )
}
