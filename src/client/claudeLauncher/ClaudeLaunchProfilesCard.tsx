// "Claude launch profiles" (Settings > Agent): how webterm starts Claude, e.g.
// `envman -e claude:malik-opus -- claude`. Default (`claude`) is built in and cannot be deleted.
// Normalisation warnings show inline with one-click "Apply fix"; Test probes the SAVED profile.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { Settings } from '../../shared/settings'
import { normalizeClaudeCommand } from '../../shared/claudeLaunch/claudeLaunch.normalize'
import { joinArgv } from '../../shared/claudeLaunch/shellQuote'
import { DEFAULT_CLAUDE_PROFILE, claudeProfiles, type ClaudeLaunchProfile } from '../../shared/claudeLaunch/claudeLaunch.profiles'
import { Field, SelectField } from '../SettingsFields'
import { randomId } from '../randomId'
import { testClaudeLaunch, type LaunchTest } from './claudeLaunch.client'
import { LaunchSteps } from './LaunchSteps'

type LaunchSettings = Pick<Settings, 'claudeLaunchProfiles' | 'defaultClaudeProfileId' | 'centralClaudeProfileId'>

export const PROFILES_TEXT = {
  title: 'Claude launch profiles',
  hint: 'How webterm starts Claude. Use a wrapper that injects env vars, e.g. envman -e claude:malik-opus -- claude. '
    + 'Ending with "--" is enough; claude is added for you. Flags after claude (--model …) are kept. Empty = Default.',
  add: 'Add profile',
  name: 'Profile name',
  command: 'Launch command',
  test: 'Test',
  testing: 'Testing…',
  remove: 'Delete',
  applyFix: 'Apply fix',
  willRun: 'Runs:',
  builtIn: 'Built in',
  defaultFor: 'Default for new Claude agents',
  defaultForHint: 'New Claude agent nodes remember this profile; later edits to it apply on their next launch.',
  central: 'Central Agent uses',
  sameAsDefault: 'Same as default for new agents',
  newName: (n: number): string => `Profile ${n}`,
  testFailed: (code: string): string => `Test could not run (${code}). Save, then try again.`,
}

const describe = (p: ClaudeLaunchProfile): string => (p.id === DEFAULT_CLAUDE_PROFILE.id ? `${p.name} (claude)` : p.name)

/** The card; settings + onChange come from the Agent section (patches are saved by useSettings). */
export function ClaudeLaunchProfilesCard({ settings: s, onChange }: { settings: LaunchSettings; onChange(patch: Partial<Settings>): void }): React.JSX.Element {
  const all = claudeProfiles(s)
  const patchProfile = (id: string, patch: Partial<ClaudeLaunchProfile>): void =>
    onChange({ claudeLaunchProfiles: s.claudeLaunchProfiles.map((p) => (p.id === id ? { ...p, ...patch } : p)) })
  const remove = (id: string): void => onChange({
    claudeLaunchProfiles: s.claudeLaunchProfiles.filter((p) => p.id !== id),
    // Never leave a pointer at a deleted profile: it would silently fall back at the next launch.
    ...(s.defaultClaudeProfileId === id ? { defaultClaudeProfileId: DEFAULT_CLAUDE_PROFILE.id } : {}),
    ...(s.centralClaudeProfileId === id ? { centralClaudeProfileId: '' } : {}),
  })
  const add = (): void => onChange({
    claudeLaunchProfiles: [...s.claudeLaunchProfiles, { id: randomId(), name: PROFILES_TEXT.newName(s.claudeLaunchProfiles.length + 1), command: '' }],
  })
  const options = all.map((p) => ({ value: p.id, label: describe(p) }))
  return (
    <>
      <Field label={PROFILES_TEXT.title} hint={PROFILES_TEXT.hint} setting="claudeLaunchProfiles" block>
        <div className="flex flex-col gap-2" data-card="claude-launch-profiles">
          {all.map((p) => <ProfileRow key={p.id} profile={p} onPatch={patchProfile} onRemove={remove} />)}
          <Button size="sm" variant="secondary" className="self-start" onClick={add}>{PROFILES_TEXT.add}</Button>
        </div>
      </Field>
      <SelectField id="st-defaultClaudeProfileId" setting="defaultClaudeProfileId" label={PROFILES_TEXT.defaultFor}
        hint={PROFILES_TEXT.defaultForHint} value={all.some((p) => p.id === s.defaultClaudeProfileId) ? s.defaultClaudeProfileId : DEFAULT_CLAUDE_PROFILE.id}
        options={options} onChange={(v) => onChange({ defaultClaudeProfileId: v })} />
      <SelectField id="st-centralClaudeProfileId" setting="centralClaudeProfileId" label={PROFILES_TEXT.central}
        value={all.some((p) => p.id === s.centralClaudeProfileId) ? s.centralClaudeProfileId : ''}
        options={[{ value: '', label: PROFILES_TEXT.sameAsDefault }, ...options]} onChange={(v) => onChange({ centralClaudeProfileId: v })} />
    </>
  )
}

function ProfileRow({ profile: p, onPatch, onRemove }: {
  profile: ClaudeLaunchProfile
  onPatch(id: string, patch: Partial<ClaudeLaunchProfile>): void
  onRemove(id: string): void
}): React.JSX.Element {
  const [test, setTest] = useState<LaunchTest | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const builtIn = p.id === DEFAULT_CLAUDE_PROFILE.id
  const n = normalizeClaudeCommand(p.command)
  const run = async (): Promise<void> => {
    setTesting(true)
    setTestError(null)
    try { setTest(await testClaudeLaunch({ profileId: p.id })) } catch (e) {
      setTest(null)
      setTestError(PROFILES_TEXT.testFailed(e instanceof Error ? e.message : 'error'))
    } finally { setTesting(false) }
  }
  return (
    <section className="st-card flex flex-col gap-1" aria-label={p.name} data-profile={p.id}>
      <div className="flex flex-wrap items-center gap-2">
        <Input className="st-input max-w-48" aria-label={PROFILES_TEXT.name} value={p.name} disabled={builtIn}
          onChange={(e) => onPatch(p.id, { name: e.target.value })} />
        <Input className="st-input st-mono flex-1" aria-label={`${p.name} ${PROFILES_TEXT.command}`} value={p.command}
          placeholder="envman -e project:env -- claude" disabled={builtIn} onChange={(e) => onPatch(p.id, { command: e.target.value })} />
        <Button size="sm" variant="outline" disabled={testing} onClick={() => void run()}>{testing ? PROFILES_TEXT.testing : PROFILES_TEXT.test}</Button>
        {builtIn ? <span className="text-xs opacity-70">{PROFILES_TEXT.builtIn}</span>
          : <Button size="sm" variant="ghost" onClick={() => onRemove(p.id)}>{PROFILES_TEXT.remove}</Button>}
      </div>
      <p className="m-0 text-xs opacity-70"><span>{PROFILES_TEXT.willRun}</span> <code className="st-mono">{joinArgv(n.argv)}</code></p>
      {n.warnings.length > 0 ? (
        <div role="status" className="flex flex-wrap items-center gap-2 text-xs text-amber-600">
          {n.warnings.map((w) => <span key={w}>{w}</span>)}
          {n.suggestion !== undefined ? (
            <Button size="xs" variant="secondary" onClick={() => onPatch(p.id, { command: n.suggestion })}>{PROFILES_TEXT.applyFix}</Button>
          ) : null}
        </div>
      ) : null}
      {test ? <LaunchSteps steps={test.steps} /> : null}
      {testError ? <p role="alert" className="m-0 text-xs text-destructive">{testError}</p> : null}
    </section>
  )
}
