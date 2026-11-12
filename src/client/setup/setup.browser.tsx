// Wizard step 2, Browser: which Chrome/Chromium the browser nodes use (a found one, another path
// through the existing ChromiumPathField, one downloaded here, or none), and whether it runs hidden.
// Continue writes the path (the server saves a download itself), then the `browser` capability (on
// when a browser is chosen, off for "Don't use").
import { useEffect, useState } from 'react'
import { ActionButton, ActionResult, useAction } from '@/components/ui/action'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ENV_BROWSER } from '../../shared/browser.contract'
import { callCapabilities } from '../capabilitiesApi'
import { useCentralEnv } from '../centralSettings.env'
import { ChromiumDownload } from '../ChromiumDownload'
import { ChromiumPathField } from '../ChromiumPathField'
import { useCapabilities } from '../useCapabilities'
import { SETUP_TEXT } from './setup.labels'
import { LoadRetry, StepFooter, Tiles, type StepProps } from './setup.ui'

const T = SETUP_TEXT.browser
export type BrowserChoice = 'installed' | 'other' | 'download' | 'off'

/** Step 2: pick the browser for browser nodes, or switch them off. */
export function BrowserStep({ nav }: StepProps): React.JSX.Element {
  const { data, error, refresh, recheck, toggle } = useCapabilities()
  const env = useCentralEnv()
  const chromium = data?.advanced.chromiumPath
  const candidates = chromium?.candidates ?? []
  const download = data?.advanced.chromiumDownload
  const [choice, setChoice] = useState<BrowserChoice | null>(null)
  const [downloaded, setDownloaded] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const [pathError, setPathError] = useState(false)
  const check = useAction(recheck, { label: T.checkAgain, ok: (r) => r.ok, success: (r) => (r.ok ? T.stillNone : T.loadFailed), failure: () => T.loadFailed })
  // First load decides the default: a download already running, a found browser, else another path already saved, else off.
  useEffect(() => {
    if (!chromium || choice !== null) return
    const custom = chromium.source === 'override' && !chromium.candidates.includes(chromium.value)
    setChoice(download?.supported && download.state === 'downloading' ? 'download'
      : custom ? 'other' : chromium.candidates.length > 0 ? 'installed' : 'off')
    setPicked(chromium.active && chromium.candidates.includes(chromium.active) ? chromium.active : chromium.candidates[0] ?? null)
  }, [chromium, choice, download])

  if (!data || !chromium || choice === null) {
    return (
      <div className="flex flex-col gap-3" data-setup-step="browser">
        <p role={error ? 'alert' : 'status'} className={`m-0 text-xs ${error ? 'text-destructive' : 'opacity-70'}`}>{error ? T.loadFailed : T.loading}</p>
        {error ? <LoadRetry load={refresh} /> : null}
        <StepFooter nav={nav} where={T.where} at={{ section: 'capabilities', field: 'capability.browser' }} locked={SETUP_TEXT.waitForLoad} />
      </div>
    )
  }

  const options: BrowserChoice[] = [
    ...(candidates.length > 0 ? ['installed' as const] : []),
    'other',
    ...(download?.supported ? ['download' as const] : []),
    'off',
  ]
  const commit = async (): Promise<string | null> => {
    if (choice === 'off') return (await toggle('browser', false)) ? null : T.saveFailed
    if (choice === 'installed' && picked) {
      try {
        await callCapabilities('/advanced', 'PUT', { chromiumPath: picked === candidates[0] ? '' : picked })
      } catch (e) {
        console.warn('setup: save chromium path failed', e instanceof Error ? e.message : 'error')
        return T.saveFailed
      }
      await refresh()
    }
    return (await toggle('browser', true)) ? null : T.saveFailed
  }
  const headlessKey = ENV_BROWSER.headless
  const locked = data.advanced.headlessForced === 'no_display'
  const headlessOn = locked || env.value(headlessKey) === 'on'
  // A finished download is already saved as the browser to use; Continue only turns the capability on.
  const continueLock = choice === 'installed' && !picked ? T.needPick : choice === 'other' && !chromium.active ? T.needPath : choice === 'download' && !downloaded ? T.needDownload : undefined
  const headlessLock = locked ? T.headlessLocked : env.load.status !== 'ready' ? T.headlessLoading : undefined
  // Feedback for the switch is the env save state below it (saving disables it, a failure says so).
  const setHeadless = (v: boolean): void => { void env.write(headlessKey, v ? 'on' : null) }

  return (
    <div className="flex flex-col gap-3" data-setup-step="browser">
      {candidates.length === 0 ? (
        <div className="flex flex-col gap-1 text-xs" data-browser-none>
          <p className="m-0">{T.noneFound}</p>
          <div className="flex items-center gap-2">
            <a className="underline" href={T.chromeUrl} target="_blank" rel="noreferrer">{T.getChrome}</a>
            <ActionButton size="sm" variant="outline" action={check} busyLabel={T.checking}>{T.checkAgain}</ActionButton>
          </div>
          <ActionResult action={check} stamp="checked" />
        </div>
      ) : null}
      <Tiles<BrowserChoice> label={SETUP_TEXT.steps.browser} options={options} names={T} value={choice} onChange={setChoice} />
      {choice === 'installed' && candidates.length > 1 ? (
        <Tiles label={T.pick} options={candidates} names={Object.fromEntries(candidates.map((c) => [c, c]))} value={picked ?? candidates[0]} onChange={setPicked} />
      ) : null}
      {choice === 'other' ? (
        <ChromiumPathField chromium={chromium} redetect={refresh} save={async (chromiumPath) => {
          try {
            await callCapabilities('/advanced', 'PUT', { chromiumPath })
            setPathError(false)
          } catch (e) {
            console.warn('setup: save chromium path failed', e instanceof Error ? e.message : 'error')
            setPathError(true)
          }
          await refresh()
        }} />
      ) : null}
      {choice === 'download' ? <ChromiumDownload onDone={refresh} onStatus={(st) => setDownloaded(st.state === 'done')} /> : null}
      {choice === 'other' && pathError ? <p role="alert" className="m-0 text-xs text-destructive">{T.saveFailed}</p> : null}
      {choice !== 'off' ? (
        <div className="flex items-start gap-2">
          <Switch id="setup-headless" checked={headlessOn} aria-describedby="setup-headless-reason"
            disabled={headlessLock !== undefined || env.saveState(headlessKey)?.status === 'saving'} onCheckedChange={setHeadless} />
          <div className="flex flex-col">
            <Label htmlFor="setup-headless">{T.headless}</Label>
            <span className="text-xs opacity-70">{T.headlessHint}</span>
            {headlessLock ? <DisabledReason id="setup-headless-reason" reason={headlessLock} /> : null}
            {env.saveState(headlessKey)?.status === 'error' ? <span role="alert" className="text-xs text-destructive">{T.saveFailed}</span> : null}
          </div>
        </div>
      ) : null}
      <StepFooter nav={nav} where={T.where} at={{ section: 'capabilities', field: 'capability.browser' }} commit={commit} locked={continueLock} />
    </div>
  )
}
