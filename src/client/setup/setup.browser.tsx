// Wizard step 2, Browser: which Chrome/Chromium the browser nodes use (a found one, another path
// through the existing ChromiumPathField, or none), and whether it runs hidden. Continue writes the
// path, then the `browser` capability (on when a browser is chosen, off for "Don't use").
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ENV_BROWSER } from '../../shared/browser.contract'
import { callCapabilities } from '../capabilitiesApi'
import { useCentralEnv } from '../centralSettings.env'
import { ChromiumPathField } from '../ChromiumPathField'
import { useCapabilities } from '../useCapabilities'
import { SETUP_TEXT } from './setup.labels'
import { StepFooter, Tiles, type StepProps } from './setup.ui'

const T = SETUP_TEXT.browser
export type BrowserChoice = 'installed' | 'other' | 'download' | 'off'

/** Optional server fields a later server change adds; absent = hidden / not locked. */
interface AdvancedExtras {
  /** Server can download a Chromium for the user (renders the "Download Chromium" option). */
  chromiumDownload?: unknown
  /** `no_display`: Linux server without a display, the browser can only run headless. */
  headlessForced?: string | null
}

/** Step 2: pick the browser for browser nodes, or switch them off. */
export function BrowserStep({ nav }: StepProps): React.JSX.Element {
  const { data, error, refresh, recheck, toggle } = useCapabilities()
  const env = useCentralEnv()
  const chromium = data?.advanced.chromiumPath
  const candidates = chromium?.candidates ?? []
  const extras = (data?.advanced ?? {}) as AdvancedExtras
  const [choice, setChoice] = useState<BrowserChoice | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [pathError, setPathError] = useState(false)
  // First load decides the default: a found browser, else another path already saved, else off.
  useEffect(() => {
    if (!chromium || choice !== null) return
    const custom = chromium.source === 'override' && !chromium.candidates.includes(chromium.value)
    setChoice(custom ? 'other' : chromium.candidates.length > 0 ? 'installed' : 'off')
    setPicked(chromium.active && chromium.candidates.includes(chromium.active) ? chromium.active : chromium.candidates[0] ?? null)
  }, [chromium, choice])

  if (!data || !chromium || choice === null) {
    return (
      <div className="flex flex-col gap-3" data-setup-step="browser">
        <p role={error ? 'alert' : 'status'} className={`m-0 text-xs ${error ? 'text-destructive' : 'opacity-70'}`}>{error ? T.loadFailed : T.loading}</p>
        {error ? <Button size="sm" variant="outline" className="self-start" onClick={() => void refresh()}>{SETUP_TEXT.retry}</Button> : null}
        <StepFooter nav={nav} where={T.where} disabled />
      </div>
    )
  }

  const options: BrowserChoice[] = [
    ...(candidates.length > 0 ? ['installed' as const] : []),
    'other',
    // SLOT(onboarding): shown only once the server reports `advanced.chromiumDownload`; the worker
    // adding that field wires the download into `commit` below (until then Continue stays disabled).
    ...(extras.chromiumDownload ? ['download' as const] : []),
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
  const locked = extras.headlessForced === 'no_display'
  const headlessOn = locked || env.value(headlessKey) === 'on'
  const canContinue = choice === 'off' || (choice === 'installed' && !!picked) || (choice === 'other' && !!chromium.active)

  return (
    <div className="flex flex-col gap-3" data-setup-step="browser">
      {candidates.length === 0 ? (
        <div className="flex flex-col gap-1 text-xs" data-browser-none>
          <p className="m-0">{T.noneFound}</p>
          <div className="flex items-center gap-2">
            <a className="underline" href={T.chromeUrl} target="_blank" rel="noreferrer">{T.getChrome}</a>
            <Button size="sm" variant="outline" onClick={() => void recheck()}>{T.checkAgain}</Button>
          </div>
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
      {choice === 'other' && pathError ? <p role="alert" className="m-0 text-xs text-destructive">{T.saveFailed}</p> : null}
      {choice !== 'off' ? (
        <div className="flex items-start gap-2">
          <Switch id="setup-headless" checked={headlessOn} disabled={locked || env.load.status !== 'ready' || env.savingKey === headlessKey}
            onCheckedChange={(v) => void env.write(headlessKey, v ? 'on' : null)} />
          <div className="flex flex-col">
            <Label htmlFor="setup-headless">{T.headless}</Label>
            <span className="text-xs opacity-70">{locked ? T.headlessLocked : T.headlessHint}</span>
            {env.saveError?.key === headlessKey ? <span role="alert" className="text-xs text-destructive">{T.saveFailed}</span> : null}
          </div>
        </div>
      ) : null}
      <StepFooter nav={nav} where={T.where} commit={commit} disabled={!canContinue} />
    </div>
  )
}
