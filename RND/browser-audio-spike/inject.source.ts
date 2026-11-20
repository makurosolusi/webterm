// SPIKE: jangan merge ke produk. Script yang di-inject lewat Page.addScriptToEvaluateOnNewDocument (jalan di tiap frame/realm).
// Satu bus per realm, dibuat LAZY (halaman tanpa audio tidak membayar apa pun): AudioContext -> MediaStreamDestination -> MediaRecorder(opus)
// -> binding. Sumber: <audio>/<video> (mode 'mes' = createMediaElementSource, 'cap' = captureStream) dan WebAudio (tee dari AudioNode.connect(destination)).
export const BINDING = '__wtAudio'
export interface InjectOpts { mode: 'mes' | 'cap'; timeslice: number; bitrate?: number }

export function injectSource(o: InjectOpts): string {
  return `(() => {
  if (window.__wtAudioInstalled) return; window.__wtAudioInstalled = true
  const OPTS = ${JSON.stringify(o)}
  const NativeAC = window.AudioContext || window.webkitAudioContext
  if (!NativeAC || typeof MediaRecorder === 'undefined') return
  // Natives captured BEFORE page code runs: a page that later freezes/overwrites prototypes cannot unhook us.
  const nConnect = AudioNode.prototype.connect, nDisconnect = AudioNode.prototype.disconnect
  const nPlay = HTMLMediaElement.prototype.play
  const send = window.${BINDING}
  const fid = Math.random().toString(36).slice(2, 8)
  const LOG = (m) => { try { send(JSON.stringify({ k: 'log', f: fid, m })) } catch {} }
  let bus = null
  const mediaDone = new WeakSet()
  const tees = new WeakMap()
  const b64 = (buf) => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s) }

  function getBus() {
    if (bus) return bus
    const ctx = new NativeAC({ latencyHint: 'interactive' })
    const dest = ctx.createMediaStreamDestination()
    const mime = 'audio/webm;codecs=opus'
    const rec = new MediaRecorder(dest.stream, { mimeType: mime, ...(OPTS.bitrate ? { audioBitsPerSecond: OPTS.bitrate } : {}) })
    let seq = 0
    rec.ondataavailable = async (e) => {
      if (!e.data.size) return
      const tChunk = Date.now()
      const d = b64(await e.data.arrayBuffer())
      send(JSON.stringify({ k: 'c', f: fid, s: seq++, t: tChunk, ts: Date.now(), n: e.data.size, d }))
    }
    rec.onerror = (e) => LOG('recorder error ' + (e.error && e.error.name))
    const tryResume = () => { if (ctx.state === 'suspended') ctx.resume().catch(() => {}) }
    for (const ev of ['pointerdown', 'keydown', 'click']) addEventListener(ev, tryResume, { capture: true, passive: true })
    ctx.resume().catch(() => {})
    rec.start(OPTS.timeslice)
    send(JSON.stringify({ k: 's', f: fid, t: Date.now(), mime, state: ctx.state, url: location.href.slice(0, 80) }))
    bus = { ctx, dest, rec, tryResume }
    return bus
  }

  function hookMedia(el) {
    if (mediaDone.has(el)) return
    mediaDone.add(el)
    try {
      const b = getBus()
      if (OPTS.mode === 'mes') {
        const src = b.ctx.createMediaElementSource(el)
        nConnect.call(src, b.dest)
      } else {
        const add = (st) => { if (st.getAudioTracks().length) nConnect.call(b.ctx.createMediaStreamSource(new MediaStream(st.getAudioTracks())), b.dest) }
        const st = (el.captureStream || el.mozCaptureStream).call(el)
        add(st)
        let done = st.getAudioTracks().length > 0
        st.addEventListener('addtrack', () => { if (!done && st.getAudioTracks().length) { done = true; add(st) } })
      }
      b.tryResume()
    } catch (e) { LOG('hookMedia failed ' + e.name + ': ' + e.message) }
  }
  HTMLMediaElement.prototype.play = function () { hookMedia(this); return nPlay.apply(this, arguments) }
  addEventListener('play', (e) => { if (e.target instanceof HTMLMediaElement) hookMedia(e.target) }, true) // autoplay attribute without play()

  // WebAudio: when something connects to a context's destination, tee a copy into the shared bus (via a per-context MediaStreamDestination).
  function teeFor(ctx) {
    let t = tees.get(ctx)
    if (t) return t
    const gain = ctx.createGain()
    const msd = ctx.createMediaStreamDestination()
    nConnect.call(gain, msd)
    const b = getBus()
    if (b.ctx === ctx) return null
    nConnect.call(b.ctx.createMediaStreamSource(msd.stream), b.dest)
    tees.set(ctx, (t = gain))
    return t
  }
  AudioNode.prototype.connect = function (dest) {
    if (dest instanceof AudioDestinationNode && this.context !== (bus && bus.ctx)) { try { const t = teeFor(this.context); if (t) nConnect.call(this, t) } catch (e) { LOG('tee failed ' + e.message) } }
    return nConnect.apply(this, arguments)
  }
  AudioNode.prototype.disconnect = function (dest) {
    if (dest instanceof AudioDestinationNode) { const t = tees.get(this.context); if (t) { try { nDisconnect.call(this, t) } catch {} } }
    else if (arguments.length === 0) { const t = tees.get(this.context); if (t) { try { nDisconnect.call(this, t) } catch {} } }
    return nDisconnect.apply(this, arguments)
  }
})()`
}
