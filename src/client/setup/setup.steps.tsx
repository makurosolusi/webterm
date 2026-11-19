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
import { CommandsStep } from './setup.commands'
import { ClaudeStep } from './setup.claude'
import { SETUP_TEXT } from './setup.labels'
import { StepFooter, StepLoading, StepPage, Tiles, type StepProps, type StepSetting } from './setup.ui'

/** How much Central may do; each level is the capability of that name (it implies the ones before). */
export type CentralLevel = 'off' | 'central' | 'workers' | 'autonomy'
const LEVELS: readonly CentralLevel[] = ['off', 'central', 'workers', 'autonomy']
const CENTRAL_SETTING: StepSetting = { where: SETUP_TEXT.central.where, section: 'central', field: 'central.level' }
const BASICS_SETTING: StepSetting = { where: SETUP_TEXT.basics.where, section: 'appearance', field: 'appTheme' }

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
    return <StepLoading step="central" setting={CENTRAL_SETTING} nav={nav} error={error} loading={T.loading} failed={T.loadFailed} retry={refresh} />
  }
  // Turn the chosen level on (prerequisites follow) and the next level off (its dependents follow).
  const commit = async (): Promise<string | null> => {
    const ok = level === 'off' ? await toggle('central', false)
      : (await toggle(level, true)) && (level === 'autonomy' || (await toggle(LEVELS[LEVELS.indexOf(level) + 1] as 'workers' | 'autonomy', false)))
    return ok ? null : T.saveFailed
  }
  return (
    <StepPage step="central" setting={CENTRAL_SETTING} footer={<StepFooter nav={nav} commit={commit} />}>
      <Tiles<CentralLevel> label={T.pick} options={LEVELS} names={T.modes} help={T.help} value={level} onChange={setLevel} />
      {level !== 'off' ? <CentralLaunchStatus /> : null}
    </StepPage>
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
    <StepPage step="basics" setting={BASICS_SETTING} footer={<StepFooter nav={nav} />}>
      <Tiles label={T.theme} options={THEMES} names={T.themes} value={settings.appTheme} onChange={(appTheme) => update({ appTheme })} />
      <ProjectsFolderSetting value={settings.defaultProjectsFolder} onChange={(defaultProjectsFolder) => update({ defaultProjectsFolder })} />
      <div className="flex items-start gap-2">
        <Switch id="setup-notify" checked={notify.on} disabled={notify.lock !== undefined} aria-describedby="setup-notify-reason" onCheckedChange={notify.set} />
        <div className="flex flex-col">
          <Label htmlFor="setup-notify">{T.notify}</Label>
          <span className="text-xs text-(--vscode-descriptionForeground)">{T.notifyHint}</span>
          {notify.lock ? <DisabledReason id="setup-notify-reason" {...notify.lock} /> : null}
          {notify.refused ? <p id="setup-notify-reason" role="alert" className="m-0 text-xs">{NOTIFY_TEXT.refused}</p> : null}
        </div>
      </div>
      <p className="m-0 flex flex-wrap items-center gap-x-1 text-xs">
        <span>{T.telegram}:</span>
        <Button size="xs" variant="link" className="h-auto min-h-0 px-0" onClick={openCapabilities}>{T.telegramLater}</Button>
      </p>
      <p className="m-0 text-xs text-(--vscode-descriptionForeground)">{T.telemetry}</p>
    </StepPage>
  )
}

/** One screen per step, in `SETUP_STEPS` order. */
export function SetupStepBody({ step, nav, settings, update }: StepProps & { step: SetupStep; settings: Settings; update(patch: SettingsPatch): void }): React.JSX.Element {
  if (step === 'claude') return <ClaudeStep nav={nav} />
  if (step === 'browser') return <BrowserStep nav={nav} />
  if (step === 'commands') return <CommandsStep nav={nav} />
  if (step === 'central') return <CentralStep nav={nav} />
  return <BasicsStep nav={nav} settings={settings} update={update} />
}
