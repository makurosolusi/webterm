// Settings › Browser › Sound: whether browser nodes that never chose start with sound on (default) or muted. A switch over the
// env key WEBTERM_BROWSER_AUDIO_DEFAULT, written through the same `/api/settings/env` PUT as the other registry rows. The default
// itself lives in the registry (the entry's `default`), not here. A change reaches open nodes at once: the shared browser status
// is re-read after the save, and only nodes without a saved choice follow it.
import { Switch } from '@/components/ui/switch'
import { ENV_BROWSER } from '../shared/browser.contract'
import { useBrowserStatus, resetBrowserStatusCache } from './browser.feature'
import { useCentralEnv } from './centralSettings.env'
import { Field, lockReasonId } from './SettingsFieldRow'
import { SettingsMessage } from './SettingsMessage'

export const AUDIO_DEFAULT_TEXT = {
  label: 'Play sound in new browser nodes',
  hint: 'On: a browser node plays its page sound as soon as you interact with the page. Off: nodes start muted and you unmute each one with the speaker button. A node you muted or unmuted yourself keeps its choice.',
  off: 'Turn the browser on under Features to change this.',
  audioOff: 'Browser audio is turned off on this server, so no browser node plays sound.',
  loadFailed: 'The setting could not be loaded.',
  retry: 'Retry',
} as const

const ID = 'st-browserAudioDefault'
const KEY = ENV_BROWSER.audioDefault

export function BrowserAudioDefaultField(): React.JSX.Element {
  const env = useCentralEnv()
  const status = useBrowserStatus()
  const loaded = env.load.status === 'ready'
  const on = env.value(KEY) !== 'off'
  const save = (next: string | null): void => { void env.write(KEY, next).then((ok) => { if (ok) resetBrowserStatusCache() }) }
  const lock = !status ? { reason: AUDIO_DEFAULT_TEXT.off } : status.audio === false ? { reason: AUDIO_DEFAULT_TEXT.audioOff } : undefined
  return (
    <Field label={AUDIO_DEFAULT_TEXT.label} hint={AUDIO_DEFAULT_TEXT.hint} htmlFor={ID} field="browser-audio" lock={lock}
      save={env.saveState(KEY)} modified={loaded && env.modified(KEY)} onReset={() => save(null)}>
      {env.load.status === 'error'
        ? <SettingsMessage kind="error" action={{ label: AUDIO_DEFAULT_TEXT.retry, run: env.reload }}>{AUDIO_DEFAULT_TEXT.loadFailed}</SettingsMessage>
        : <Switch id={ID} checked={on} disabled={!loaded || lock !== undefined} aria-describedby={lock ? lockReasonId(ID) : undefined} onCheckedChange={(v) => save(v ? 'on' : 'off')} />}
    </Field>
  )
}
