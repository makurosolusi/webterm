// Settings › Browser › Active browsers limit: a stepper over the env key WEBTERM_BROWSER_MAX_LIVE, written through the
// same `/api/settings/env` PUT as the other registry rows (useCentralEnv: optimistic value, rollback + Retry on error).
// The runtime reads the limit on every open, so a change applies at once; "Active now" is the live count from /status.
import { useEffect, useState } from 'react'
import { DEFAULT_MAX_LIVE, ENV_BROWSER, MAX_LIVE_RANGE } from '../shared/browser.contract'
import type { BrowserStatusResp } from '../shared/browser.contract'
import { getBrowserStatus } from './browser.api'
import { Stepper } from './centralSettings.controls'
import { useCentralEnv } from './centralSettings.env'
import { Field } from './SettingsFieldRow'
import { SettingsMessage } from './SettingsMessage'

export const LIMIT_TEXT = {
  label: 'Active browsers limit',
  hint: 'Each active browser keeps a Chromium page in memory. The oldest hidden browser is paused, then discarded.',
  highWarning: 'High values need plenty of memory.',
  off: 'Turn the browser on under Features to change this.',
  loadFailed: 'The limit could not be loaded.',
  retry: 'Retry',
  activeNow: (live: number, max: number): string => `Active now: ${live} of ${max}`,
  over: (live: number): string => `${live} active now; extra browsers will be paused when hidden`,
} as const

/** Above this the warning shows (a Chromium page is roughly a few hundred MB). */
export const HIGH_LIMIT = 6
const POLL_MS = 5000
const ID = 'st-browserLimit'

/** Live status of the browser runtime: refreshed every few seconds, on window focus and when `refresh` changes. */
function useLiveStatus(refresh: number): BrowserStatusResp | null {
  const [status, setStatus] = useState<BrowserStatusResp | null>(null)
  useEffect(() => {
    let alive = true
    const load = (): void => { getBrowserStatus().then((s) => { if (alive) setStatus(s.enabled ? s : null) }, () => { if (alive) setStatus(null) }) }
    load()
    const timer = setInterval(load, POLL_MS)
    window.addEventListener('focus', load)
    return () => { alive = false; clearInterval(timer); window.removeEventListener('focus', load) }
  }, [refresh])
  return status
}

export function BrowserLimitField(): React.JSX.Element {
  const env = useCentralEnv()
  const { reload } = env
  const [bump, setBump] = useState(0)
  const status = useLiveStatus(bump)
  useEffect(() => { // another window changed it: read the stored value again on focus
    window.addEventListener('focus', reload)
    return () => window.removeEventListener('focus', reload)
  }, [reload])
  const key = ENV_BROWSER.maxLive
  const loaded = env.load.status === 'ready'
  const value = Number(env.value(key)) || DEFAULT_MAX_LIVE
  const save = (next: number | null): void => { void env.write(key, next === null ? null : String(next)).then(() => setBump((n) => n + 1)) }
  const lock = status ? undefined : { reason: LIMIT_TEXT.off }
  return (
    <Field label={LIMIT_TEXT.label} hint={LIMIT_TEXT.hint} htmlFor={ID} field="browser-limit" lock={lock}
      save={env.saveState(key)} modified={loaded && value !== DEFAULT_MAX_LIVE} onReset={() => save(null)}>
      {env.load.status === 'error'
        ? <SettingsMessage kind="error" action={{ label: LIMIT_TEXT.retry, run: reload }}>{LIMIT_TEXT.loadFailed}</SettingsMessage>
        : <Stepper id={ID} label={LIMIT_TEXT.label} value={value} min={MAX_LIVE_RANGE.min} max={MAX_LIVE_RANGE.max} step={1}
            disabled={!loaded || !status} onChange={(n) => save(n)} />}
      {status && <span className="st-hint" role="status" data-testid="browser-limit-live">{status.live > value ? LIMIT_TEXT.over(status.live) : LIMIT_TEXT.activeNow(status.live, value)}</span>}
      {value > HIGH_LIMIT && <span className="st-hint" role="note">{LIMIT_TEXT.highWarning}</span>}
    </Field>
  )
}
