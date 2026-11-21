// Script injected into every frame (Page.addScriptToEvaluateOnNewDocument) to capture the page's sound in-page:
// sources (<audio>/<video> via createMediaElementSource, WebAudio via a tee on AudioNode.connect) -> one lazy bus per realm ->
// MediaRecorder(opus/webm) -> the CDP binding. Derived from RND/browser-audio-spike (mode `mes`); evidence in docs/decisions/browser-audio.md.
// The injected text makes no network call and uses no eval (policy test): data leaves only through the CDP binding.
import { AUDIO_BINDING, AUDIO_BITS_PER_SECOND, AUDIO_MIME, AUDIO_TIMESLICE_MS } from '../../shared/browser.contract.audio'

/** Global functions the host evaluates in a frame to start/stop the recorder (cost is paid only while someone listens). */
export const AUDIO_PAUSE_FN = '__wtAudioPause'
export const AUDIO_RESUME_FN = '__wtAudioResume'

/** Source text of the capture script. Pure: same output every call. */
export function audioInjectSource(): string {
  return `(() => {
  if (window.__wtAudioInstalled) return
  const O = ${JSON.stringify({ timeslice: AUDIO_TIMESLICE_MS, bitrate: AUDIO_BITS_PER_SECOND, mime: AUDIO_MIME })}
  const NativeAC = window.AudioContext || window.webkitAudioContext
  const send = window.${AUDIO_BINDING}
  if (!NativeAC || typeof MediaRecorder === 'undefined' || typeof send !== 'function') return // no binding yet (Runtime not enabled when this document began): installed later by the host
  window.__wtAudioInstalled = true
  // Natives are captured BEFORE page code runs: a page that later freezes or overwrites prototypes cannot unhook us.
  const nConnect = AudioNode.prototype.connect, nDisconnect = AudioNode.prototype.disconnect, nPlay = HTMLMediaElement.prototype.play
  const post = (m) => { try { send(JSON.stringify(m)) } catch (e) {} }
  const fid = Math.random().toString(36).slice(2, 8)
  const isChild = window.parent !== window
  let bus = null, rec = null, want = false, gen = 0
  const mediaDone = new WeakSet(), tees = new WeakMap()
  const b64 = (buf) => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s) }
  const ask = () => { if (isChild) try { window.parent.postMessage({ __wtAudio: 'ask' }, '*') } catch (e) {} }

  // One recorder run = one stream key; seq 0 carries the WebM header. A new run (resume, navigation) means a new key.
  function startRec() {
    if (!bus || rec || !want) return
    const key = fid + (gen++).toString(36)
    const r = new MediaRecorder(bus.dest.stream, { mimeType: O.mime, audioBitsPerSecond: O.bitrate })
    let seq = 0
    r.ondataavailable = async (e) => { if (!e.data.size) return; const n = seq++; post({ k: 'c', f: key, s: n, d: b64(await e.data.arrayBuffer()) }) }
    r.start(O.timeslice)
    rec = r
  }
  function stopRec() { if (rec) { try { rec.stop() } catch (e) {} rec = null } }
  const relay = (cmd) => { for (let i = 0; i < window.frames.length; i++) try { window.frames[i].postMessage({ __wtAudio: cmd }, '*') } catch (e) {} }
  const resume = () => { want = true; startRec(); relay('resume') }
  const pause = () => { want = false; stopRec(); relay('pause') }
  window.${AUDIO_RESUME_FN} = resume
  window.${AUDIO_PAUSE_FN} = pause
  // Same-site and sandboxed iframes cannot be reached by Runtime.evaluate on the page session: the toggle is relayed down the frame tree.
  addEventListener('message', (e) => {
    const m = e.data
    if (!m || typeof m !== 'object' || !m.__wtAudio) return
    if (m.__wtAudio === 'ask') { if (want && e.source) try { e.source.postMessage({ __wtAudio: 'resume' }, '*') } catch (x) {} return }
    if (!isChild || e.source !== window.parent) return
    if (m.__wtAudio === 'resume') resume(); else if (m.__wtAudio === 'pause') pause()
  })
  ask()

  function getBus() {
    if (bus) return bus
    const ctx = new NativeAC({ latencyHint: 'interactive' })
    const dest = ctx.createMediaStreamDestination()
    const tryResume = () => { if (ctx.state === 'suspended') ctx.resume().catch(() => {}) }
    for (const ev of ['pointerdown', 'keydown', 'click']) addEventListener(ev, tryResume, { capture: true, passive: true })
    ctx.resume().catch(() => {})
    bus = { ctx, dest, tryResume }
    post({ k: 'b', f: fid }) // tells the host a stream exists (audioActive) and lets it resume this realm if someone listens
    ask()
    startRec()
    return bus
  }

  function hookMedia(el) {
    if (mediaDone.has(el)) return
    mediaDone.add(el)
    try {
      const b = getBus()
      nConnect.call(b.ctx.createMediaElementSource(el), b.dest)
      b.tryResume()
    } catch (e) {}
  }
  HTMLMediaElement.prototype.play = function () { hookMedia(this); return nPlay.apply(this, arguments) }
  addEventListener('play', (e) => { if (e.target instanceof HTMLMediaElement) hookMedia(e.target) }, true) // autoplay attribute without play()

  // WebAudio: when something connects to a context's destination, tee a copy into the shared bus via a per-context MediaStreamDestination.
  function teeFor(ctx) {
    let t = tees.get(ctx)
    if (t) return t
    const gain = ctx.createGain(), msd = ctx.createMediaStreamDestination()
    nConnect.call(gain, msd)
    const b = getBus()
    if (b.ctx === ctx) return null
    nConnect.call(b.ctx.createMediaStreamSource(msd.stream), b.dest)
    tees.set(ctx, (t = gain))
    return t
  }
  AudioNode.prototype.connect = function (dest) {
    if (dest instanceof AudioDestinationNode && this.context !== (bus && bus.ctx)) { try { const t = teeFor(this.context); if (t) nConnect.call(this, t) } catch (e) {} }
    return nConnect.apply(this, arguments)
  }
  AudioNode.prototype.disconnect = function (dest) {
    if (dest instanceof AudioDestinationNode || arguments.length === 0) { const t = tees.get(this.context); if (t) { try { nDisconnect.call(this, t) } catch (e) {} } }
    return nDisconnect.apply(this, arguments)
  }
  // Installed late (first listener): media that is already playing never calls play() again, so pick it up now.
  try { for (const el of document.querySelectorAll('audio,video')) if (!el.paused) hookMedia(el) } catch (e) {}
})()`
}
