// Browser node audio (docs/decisions/browser-audio.md): constants + types shared by the server capture, the WS gateway and
// the client player. The binary frame is `[3][idLen][nodeId][keyLen][streamKey][seq u32][t f64][payload]` (see browser.wire.ts).

/** Server -> client binary frame carrying one opus/webm chunk; any client that does not know the type ignores it (as for FRAME_TYPE_TIMED). */
export const FRAME_TYPE_AUDIO = 3
/** `Runtime.addBinding` name the injected script calls with each chunk (JSON string). */
export const AUDIO_BINDING = '__wtAudio'
/** MediaRecorder chunk length in ms (the recorder does not honour it exactly: about 8 chunks/s measured). */
export const AUDIO_TIMESLICE_MS = 100
/** Opus bitrate in bits/s (about 85 kbps on the wire with the base64 hop). */
export const AUDIO_BITS_PER_SECOND = 64_000
/** MIME type of every chunk; the first chunk of a stream (seq 0) holds the WebM header and is needed to start decoding. */
export const AUDIO_MIME = 'audio/webm;codecs=opus'
/** Newest chunks kept per listener when its socket is slow: ~1 s of audio; older ones are dropped (video is never blocked). */
export const AUDIO_BACKLOG_MAX_CHUNKS = 10
/** Socket buffer above which a listener gets no new audio chunk until it drains. */
export const AUDIO_MAX_BUFFERED_BYTES = 262_144
/** Stream key = page-chosen short id of one recorder run; a new key means "reset your decoder" (navigation, restart). */
export const AUDIO_STREAM_KEY = /^[a-z0-9]{1,16}$/
/** Largest chunk (decoded bytes) the server accepts from a page; larger = dropped (a page cannot flood the socket). */
export const AUDIO_CHUNK_MAX_BYTES = 262_144
/** Handshake capability name: `BrowserStatusResp.audio`. */
export const AUDIO_CAPABILITY = 'audio'

/** One decoded chunk on its way to listeners. `seq` 0 = init segment of the stream; `t` = server receive time (ms epoch). */
export interface AudioChunk { nodeId: string; streamKey: string; seq: number; t: number; payload: Uint8Array }
