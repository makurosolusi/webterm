// Wizard steps 3 and 4 (Central Agent, Basics) plus the step registry the dialog renders. Steps 1
// and 2 live in `setup.claude.tsx` / `setup.browser.tsx` (each is a screen of its own).
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import type { CapabilitiesResponse } from '../../shared/featureCapabilities'
import type { Settings } from '../../shared/settings'
import type { SettingsPatch } from '../../shared/settings.patch'
import type { SetupStep } from '../../shared/settings.setup'
import type { AppTheme } from '../../shared/settings.terminal'
import { CentralLaunchStatus } from '../claudeLauncher/CentralLaunchStatus'
import { openSettingsAt } from '../settings.link'
import { NOTIFY_TEXT, useDesktopNotify } from '../osNotify.settings'
import { useCapabilities } from '../useCapabilities'
import { ProjectsFolderSetting } from '../workspaceCreate/ProjectsFolderSetting'
import { BrowserStep } from './setup.browser'
import { ClaudeStep } from './setup.claude'
import { SETUP_TEXT } from './setup.labels'
import { LoadRetry, StepFooter, Tiles, type StepProps } from './setup.ui'

/** How much Central may do; each level is the capability of that name (it implies the ones before). */
export type CentralLevel = 'off' | 'central' | 'workers' | 'autonomy'
const LEVELS: readonly CentralLevel[] = ['off', 'central', 'workers', 'autonomy']

/** The level the server's capability state amounts to (highest one on). */
export function centralLevel(data: CapabilitiesResponse): CentralLevel {
  const on = (id: string): boolean => data.capabilities.some((c) => c.id === id && c.status !== 'off')
  return on('autonomy') ? 'autonomy' : on('workers') ? 'workers' : on('central') ? 'central' : 'off'
}

/** Step 3: Central Agent level, written as the capability chain (the server closes prerequisites). */
export function CentralStep({ nav }: StepProps): React.JSX.Element {
  const T = SETUP_TEXT.central
  const { data, error, refresh, toggle } = useCapabilities()
  const [level, setLevel] = useState<CentralLevel | null>(null)
  useEffect(() => { if (data && level === null) setLevel(centralLevel(data)) }, [data, level])
  if (!data || level === null) {
    return (
      <div className="flex flex-col gap-3" data-setup-step="central">
        <p role={error ? 'alert' : 'status'} className={`m-0 text-xs ${error ? 'text-destructive' : 'opacity-70'}`}>{error ? T.loadFailed : T.loading}</p>
        {error ? <LoadRetry load={refresh} /> : null}
        <StepFooter nav={nav} where={T.where} at={{ section: 'capabilities', field: 'capability.central' }} locked={SETUP_TEXT.waitForLoad} />
      </div>
    )
  }
  // Turn the chosen level on (prerequisites follow) and the next level off (its dependents follow).
  const commit = async (): Promise<string | null> => {
    const ok = level === 'off' ? await toggle('central', false)
      : (await toggle(level, true)) && (level === 'autonomy' || (await toggle(LEVELS[LEVELS.indexOf(level) + 1] as 'workers' | 'autonomy', false)))
    return ok ? null : T.saveFailed
  }
  return (
    <div className="flex flex-col gap-3" data-setup-step="central">
      <p className="m-0 text-sm">{T.intro}</p>
      <Tiles<CentralLevel> label={T.pick} options={LEVELS} names={T.modes} help={T.help} value={level} onChange={setLevel} />
      {level !== 'off' ? <CentralLaunchStatus /> : null}
      <StepFooter nav={nav} where={T.where} at={{ section: 'capabilities', field: 'capability.central' }} commit={commit} />
    </div>
  )
}

const THEMES: readonly AppTheme[] = ['auto', 'light', 'dark']

/** Step 4: theme, projects folder, desktop notifications; applied as they are chosen. */
export function BasicsStep({ nav, settings, update }: StepProps & { settings: Settings; update(patch: SettingsPatch): void }): React.JSX.Element {
  const T = SETUP_TEXT.basics
  // Real permission, as in Settings › Notifications: never "on" while the browser blocks it.
  const notify = useDesktopNotify()
  const openCapabilities = (): void => openSettingsAt('capabilities', 'capability.telegram')
  return (
    <div className="flex flex-col gap-3" data-setup-step="basics">
      <Tiles label={T.theme} options={THEMES} names={T.themes} value={settings.appTheme} onChange={(appTheme) => update({ appTheme })} />
      <ProjectsFolderSetting value={settings.defaultProjectsFolder} onChange={(defaultProjectsFolder) => update({ defaultProjectsFolder })} />
      <div className="flex items-start gap-2">
        <Switch id="setup-notify" checked={notify.on} disabled={notify.lock !== undefined} aria-describedby="setup-notify-reason" onCheckedChange={notify.set} />
        <div className="flex flex-col">
          <Label htmlFor="setup-notify">{T.notify}</Label>
          <span className="text-xs opacity-70">{T.notifyHint}</span>
          {notify.lock ? <DisabledReason id="setup-notify-reason" {...notify.lock} /> : null}
          {notify.refused ? <p id="setup-notify-reason" role="alert" className="m-0 text-xs">{NOTIFY_TEXT.refused}</p> : null}
        </div>
      </div>
      <p className="m-0 text-xs">
        {T.telegram}:{' '}
        <Button size="xs" variant="link" className="px-0" onClick={openCapabilities}>{T.telegramLater}</Button>
      </p>
      <p className="m-0 text-xs opacity-70">{T.telemetry}</p>
      <StepFooter nav={nav} where={T.where} at={{ section: 'terminal', field: 'appTheme' }} />
    </div>
  )
}

/** One screen per step, in `SETUP_STEPS` order. */
export function SetupStepBody({ step, nav, settings, update }: StepProps & { step: SetupStep; settings: Settings; update(patch: SettingsPatch): void }): React.JSX.Element {
  if (step === 'claude') return <ClaudeStep nav={nav} />
  if (step === 'browser') return <BrowserStep nav={nav} />
  if (step === 'central') return <CentralStep nav={nav} />
  return <BasicsStep nav={nav} settings={settings} update={update} />
}
