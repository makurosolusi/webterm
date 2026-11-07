// "Claude launch profiles" (Settings > Agent): how webterm starts Claude, e.g.
// `envman -e claude:malik-opus -- claude`. A list like VS Code's settings list editor: the built-in
// Default (`claude`, read-only) first, then the user's profiles with their resolved command, badges
// and Edit / Test / Delete. Add and Edit open ClaudeProfileEditor inline; Test probes the SAVED profile.
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { Settings } from '../../shared/settings'
import { joinArgv } from '../../shared/claudeLaunch/shellQuote'
import {
  DEFAULT_CLAUDE_PROFILE, centralProfileId, claudeProfiles, resolveProfileLaunch, type ClaudeLaunchProfile,
} from '../../shared/claudeLaunch/claudeLaunch.profiles'
import { Field, SelectField } from '../SettingsFields'
import { randomId } from '../randomId'
import { testClaudeLaunch, type LaunchTest } from './claudeLaunch.client'
import { ClaudeProfileEditor, type ProfileDraft } from './ClaudeProfileEditor'
import { LaunchSteps } from './LaunchSteps'

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
  useForAgents: 'Use for new Claude agents',
  useForCentral: 'Use for Central',
  dismiss: 'Dismiss',
  cancel: 'Cancel',
  defaultFor: 'Default for new Claude agents',
  defaultForHint: 'New Claude agent nodes remember this profile; later edits to it apply on their next launch.',
  central: 'Central Agent uses',
  sameAsDefault: 'Same as default for new agents',
  testFailed: (code: string): string => `Test could not run (${code}). Save, then try again.`,
}

const describe = (p: ClaudeLaunchProfile): string => (p.id === DEFAULT_CLAUDE_PROFILE.id ? `${p.name} (claude)` : p.name)
/** What a profile runs, from the same resolver the server launches with. */
const preview = (s: LaunchSettings, id: string): string => joinArgv(resolveProfileLaunch(s, id).argv)

/** The card; settings + onChange come from the Agent section (patches are saved by useSettings). */
export function ClaudeLaunchProfilesCard({ settings: s, onChange }: { settings: LaunchSettings; onChange(patch: Partial<Settings>): void }): React.JSX.Element {
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

  // Resolved, so a pointer at a deleted profile shows its badge on Default, where launches really go.
  const defaultId = resolveProfileLaunch(s).profile.id
  const centralId = resolveProfileLaunch(s, centralProfileId(s)).profile.id
  const close = (key: string): void => { setEditing(null); setFocusKey(key) }
  const save = (id: string | null, d: ProfileDraft): void => {
    if (id) onChange({ claudeLaunchProfiles: s.claudeLaunchProfiles.map((p) => (p.id === id ? { ...p, ...d } : p)) })
    else {
      const created = { id: randomId(), ...d }
      onChange({ claudeLaunchProfiles: [...s.claudeLaunchProfiles, created] })
      setJustSaved(created.id)
    }
    close(id ? `edit-${id}` : 'add')
  }
  const remove = (id: string): void => {
    onChange({
      claudeLaunchProfiles: s.claudeLaunchProfiles.filter((p) => p.id !== id),
      // Never leave a pointer at a deleted profile: it would silently fall back at the next launch.
      ...(s.defaultClaudeProfileId === id ? { defaultClaudeProfileId: DEFAULT_CLAUDE_PROFILE.id } : {}),
      ...(s.centralClaudeProfileId === id ? { centralClaudeProfileId: '' } : {}),
    })
    setFocusKey('add')
  }
  const takenBy = (id: string | null): string[] => all.filter((p) => p.id !== id).map((p) => p.name)
  const options = all.map((p) => ({ value: p.id, label: describe(p) }))
  return (
    <>
      <Field label={PROFILES_TEXT.title} hint={PROFILES_TEXT.hint} setting="claudeLaunchProfiles" block>
        <div ref={listRef} className="flex flex-col gap-2" data-card="claude-launch-profiles">
          {all.map((p) => (editing === p.id
            ? <ClaudeProfileEditor key={p.id} profile={p} taken={takenBy(p.id)} onSave={(d) => save(p.id, d)} onCancel={() => close(`edit-${p.id}`)} />
            : <ProfileRow key={p.id} profile={p} command={preview(s, p.id)} isDefault={defaultId === p.id} isCentral={centralId === p.id}
                onEdit={() => setEditing(p.id)} onRemove={() => remove(p.id)}
                saved={justSaved === p.id ? {
                  useForAgents: () => { onChange({ defaultClaudeProfileId: p.id }) },
                  useForCentral: () => { onChange({ centralClaudeProfileId: p.id }) },
                  dismiss: () => setJustSaved(null),
                } : undefined} />))}
          {s.claudeLaunchProfiles.length === 0 && editing !== 'new' ? <p className="st-hint m-0">{PROFILES_TEXT.empty}</p> : null}
          {editing === 'new'
            ? <ClaudeProfileEditor taken={takenBy(null)} onSave={(d) => save(null, d)} onCancel={() => close('add')} />
            : <Button size="sm" variant="secondary" className="self-start" data-focus-key="add" disabled={editing !== null}
                onClick={() => { setJustSaved(null); setEditing('new') }}>{PROFILES_TEXT.add}</Button>}
        </div>
      </Field>
      <SelectField id="st-defaultClaudeProfileId" setting="defaultClaudeProfileId" label={PROFILES_TEXT.defaultFor}
        hint={PROFILES_TEXT.defaultForHint} value={defaultId} options={options} onChange={(v) => onChange({ defaultClaudeProfileId: v })} />
      <SelectField id="st-centralClaudeProfileId" setting="centralClaudeProfileId" label={PROFILES_TEXT.central}
        value={all.some((p) => p.id === s.centralClaudeProfileId) ? s.centralClaudeProfileId : ''}
        options={[{ value: '', label: PROFILES_TEXT.sameAsDefault }, ...options]} onChange={(v) => onChange({ centralClaudeProfileId: v })} />
    </>
  )
}

function ProfileRow({ profile: p, command, isDefault, isCentral, onEdit, onRemove, saved }: {
  profile: ClaudeLaunchProfile
  command: string
  isDefault: boolean
  isCentral: boolean
  onEdit(): void
  onRemove(): void
  saved?: { useForAgents(): void; useForCentral(): void; dismiss(): void }
}): React.JSX.Element {
  const [test, setTest] = useState<LaunchTest | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const builtIn = p.id === DEFAULT_CLAUDE_PROFILE.id
  const run = async (): Promise<void> => {
    setTesting(true)
    setTestError(null)
    try { setTest(await testClaudeLaunch({ profileId: p.id })) } catch (e) {
      setTest(null)
      setTestError(PROFILES_TEXT.testFailed(e instanceof Error ? e.message : 'error'))
    } finally { setTesting(false) }
  }
  return (
    <section className="st-profile" aria-label={p.name} data-profile={p.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="st-profile-name">{p.name}</span>
        {builtIn ? <span className="st-profile-badge">{PROFILES_TEXT.builtIn}</span> : null}
        {isDefault ? <span className="st-profile-badge">{PROFILES_TEXT.badgeDefault}</span> : null}
        {isCentral ? <span className="st-profile-badge">{PROFILES_TEXT.badgeCentral}</span> : null}
        <span className="flex-1" />
        {builtIn ? null : <Button size="xs" variant="ghost" data-focus-key={`edit-${p.id}`} onClick={onEdit}>{PROFILES_TEXT.edit}</Button>}
        <Button size="xs" variant="outline" disabled={testing} onClick={() => void run()}>{testing ? PROFILES_TEXT.testing : PROFILES_TEXT.test}</Button>
        {builtIn ? null : <Button size="xs" variant="ghost" onClick={() => setConfirming(true)}>{PROFILES_TEXT.remove}</Button>}
      </div>
      <code className="st-mono st-profile-command">{command}</code>
      {confirming ? (
        <div role="alertdialog" aria-label={PROFILES_TEXT.confirmRemove(p.name)} className="flex flex-wrap items-center gap-2 text-xs">
          <span>{PROFILES_TEXT.confirmRemove(p.name)}</span>
          <Button size="xs" variant="destructive" autoFocus onClick={onRemove}>{PROFILES_TEXT.remove}</Button>
          <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>{PROFILES_TEXT.cancel}</Button>
        </div>
      ) : null}
      {saved ? (
        <div role="status" className="flex flex-wrap items-center gap-2 text-xs">
          <span>{PROFILES_TEXT.saved(p.name)}</span>
          {isDefault ? null : <Button size="xs" variant="secondary" onClick={saved.useForAgents}>{PROFILES_TEXT.useForAgents}</Button>}
          {isCentral ? null : <Button size="xs" variant="secondary" onClick={saved.useForCentral}>{PROFILES_TEXT.useForCentral}</Button>}
          <Button size="xs" variant="ghost" onClick={saved.dismiss}>{PROFILES_TEXT.dismiss}</Button>
        </div>
      ) : null}
      {test ? <LaunchSteps steps={test.steps} /> : null}
      {testError ? <p role="alert" className="m-0 text-xs text-destructive">{testError}</p> : null}
    </section>
  )
}
