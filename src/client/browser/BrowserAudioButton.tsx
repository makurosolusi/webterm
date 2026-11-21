// Speaker button in a browser node's header (also in the tab actions: both render the node's `extraHeader`).
// Icon = what you hear NOW (speaker = sound on, slashed speaker = muted); the label names the action the click performs.
// States: playing, connecting, blocked (waiting for a click in this tab), muted by the user, unsupported (disabled + reason), error (click = try again).
import { useId } from 'react'
import { IconButton } from '@/components/ui/icon-button'
import type { BrowserAudio } from './browserAudio.use'
import { audioSupported, TEXT as PLAYER_TEXT } from './browserAudio.player'
import './browserAudio.css'

export const AUDIO_TEXT = {
  mute: 'Mute browser audio',
  unmute: 'Unmute browser audio',
  blocked: PLAYER_TEXT.blocked,
  connecting: 'Connecting audio…',
  retry: 'Audio failed. Try again',
  unavailable: 'Browser audio unavailable',
  unsupported: PLAYER_TEXT.unsupported,
  activity: 'This page is making sound',
}

/** Show the speaker unless the server says it cannot capture audio (`audio: false`, the kill switch); older servers omit the field. */
export const audioOffered = (status: { audio?: boolean } | null): boolean => status?.audio !== false

/** The Settings default for nodes that never chose: on unless the server says `audioDefault: false` (older servers omit it = on).
 *  Status not known yet (null) = not on, so a muted-by-default setup never blips sound before the answer arrives. */
export const audioDefaultOn = (status: { audioDefault?: boolean } | null): boolean => status !== null && status.audioDefault !== false

export interface BrowserAudioButtonProps {
  audio: BrowserAudio
  /** The page has an audio stream (state.audioActive): a quiet dot while muted. */
  active?: boolean
}

export default function BrowserAudioButton({ audio, active }: BrowserAudioButtonProps): React.JSX.Element {
  const reason = useId()
  const unsupported = audio.state === 'unsupported' || !audioSupported()
  const failed = audio.state === 'error'
  const pressed = audio.on && !failed && !unsupported
  const blocked = pressed && audio.state === 'blocked'
  const label = failed ? AUDIO_TEXT.retry : !pressed ? AUDIO_TEXT.unmute : blocked ? AUDIO_TEXT.blocked : audio.state === 'playing' ? AUDIO_TEXT.mute : AUDIO_TEXT.connecting
  const icon = failed ? 'warning' : pressed ? 'unmute' : 'mute'
  return (
    <>
      <IconButton
        label={unsupported ? AUDIO_TEXT.unavailable : label} tooltip={unsupported ? AUDIO_TEXT.unsupported : label}
        size="icon-bui" className="browser-audio-btn nodrag" data-state={unsupported ? 'unsupported' : failed ? 'error' : pressed ? (audio.state === 'idle' ? 'connecting' : audio.state) : 'muted'}
        aria-pressed={pressed} aria-describedby={unsupported || failed ? reason : undefined}
        disabled={unsupported} onClick={audio.toggle}
      >
        <span className={`codicon codicon-${icon}`} aria-hidden="true" />
        {active && !pressed && !unsupported && <span className="browser-audio-btn__dot" role="img" aria-label={AUDIO_TEXT.activity} />}
      </IconButton>
      {(unsupported || failed) && <span id={reason} className="browser-audio-btn__sr">{failed && audio.message ? audio.message : AUDIO_TEXT.unsupported}</span>}
    </>
  )
}
