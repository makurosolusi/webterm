// Speaker button in a browser node's header (also in the tab actions: both render the node's `extraHeader`).
// States: muted (default), connecting, playing, unsupported (disabled + reason), error (click = try again).
import { useId } from 'react'
import { IconButton } from '@/components/ui/icon-button'
import type { BrowserAudio } from './browserAudio.use'
import { audioSupported, TEXT as PLAYER_TEXT } from './browserAudio.player'
import './browserAudio.css'

export const AUDIO_TEXT = {
  mute: 'Mute browser audio',
  unmute: 'Play browser audio',
  resume: 'Play browser audio (it was on before; browsers need a click to start sound)',
  connecting: 'Connecting audio…',
  retry: 'Audio failed. Try again',
  unavailable: 'Browser audio unavailable',
  unsupported: PLAYER_TEXT.unsupported,
  activity: 'This page is making sound',
}

/** Show the speaker unless the server says it cannot capture audio (`audio: false`, the kill switch); older servers omit the field. */
export const audioOffered = (status: { audio?: boolean } | null): boolean => status?.audio !== false

export interface BrowserAudioButtonProps {
  audio: BrowserAudio
  /** The page has an audio stream (state.audioActive): a quiet dot while muted. */
  active?: boolean
  /** The node had sound on in a previous session (saved in the layout). */
  wasOn?: boolean
}

export default function BrowserAudioButton({ audio, active, wasOn }: BrowserAudioButtonProps): React.JSX.Element {
  const reason = useId()
  const unsupported = audio.state === 'unsupported' || !audioSupported()
  const failed = audio.state === 'error'
  const pressed = audio.on && !failed && !unsupported
  const label = failed ? AUDIO_TEXT.retry : pressed ? (audio.state === 'playing' ? AUDIO_TEXT.mute : AUDIO_TEXT.connecting) : wasOn ? AUDIO_TEXT.resume : AUDIO_TEXT.unmute
  const icon = pressed ? 'unmute' : failed ? 'warning' : 'mute'
  return (
    <>
      <IconButton
        label={unsupported ? AUDIO_TEXT.unavailable : label} tooltip={unsupported ? AUDIO_TEXT.unsupported : label}
        size="icon-bui" className="browser-audio-btn nodrag" data-state={unsupported ? 'unsupported' : failed ? 'error' : pressed ? audio.state : 'muted'}
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
