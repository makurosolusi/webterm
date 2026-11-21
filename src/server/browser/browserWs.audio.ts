// Audio lane of one listener (client,node): a short backlog of encoded audio frames with its own backpressure.
// Audio never waits for video and video never waits for audio: when the socket is slow the OLDEST chunks are dropped
// (about 1 s kept, AUDIO_BACKLOG_MAX_CHUNKS), because late sound is worse than a gap. Pure; the hub owns the lanes.
import { AUDIO_BACKLOG_MAX_CHUNKS, AUDIO_MAX_BUFFERED_BYTES } from '../../shared/browser.contract'
import type { ViewerSink } from './browserWs.viewers'

export interface AudioLane {
  /** Queue an encoded audio frame and send what the socket can take now. */
  push(bytes: Uint8Array): void
  /** Forget everything queued (node discarded / listener left). */
  clear(): void
  readonly depth: number
}

export function createAudioLane(sink: ViewerSink, maxChunks = AUDIO_BACKLOG_MAX_CHUNKS, maxBuffered = AUDIO_MAX_BUFFERED_BYTES): AudioLane {
  const q: Uint8Array[] = []
  const drain = (): void => {
    while (q.length > 0 && sink.bufferedAmount <= maxBuffered) {
      if (!sink.sendBinary(q.shift() as Uint8Array, drain)) { q.length = 0; return } // socket closed: the rest is moot
    }
  }
  return {
    push(bytes) {
      q.push(bytes)
      while (q.length > maxChunks) q.shift()
      drain()
    },
    clear() { q.length = 0 },
    get depth() { return q.length },
  }
}
