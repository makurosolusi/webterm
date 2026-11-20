// SPIKE: jangan merge ke produk. Halaman uji lokal (satu HTML + satu page.js eksternal supaya CSP ketat tetap bisa dites).
export const PAGE_HTML = '<!doctype html><meta charset=utf-8><title>audio spike</title><body style="margin:0"><canvas id=cv width=1280 height=800></canvas><script src="/page.js"></script>'

// No backticks / template placeholders inside: this string is embedded in a TS template literal.
export const PAGE_JS = String.raw`
const Q = new URLSearchParams(location.search)
const B = Q.get('b') // port of the second origin
const DUR = 1.4
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cv = document.getElementById('cv')
if (cv) { // detail-rich canvas: its JPEG is big, so a flip to solid red is detectable by frame size in the screencast
  const g = cv.getContext('2d'), im = g.createImageData(1280, 800)
  for (let i = 0; i < im.data.length; i += 4) { const v = Math.random() * 255; im.data[i] = v; im.data[i + 1] = 255 - v; im.data[i + 2] = (v * 7) % 255; im.data[i + 3] = 255 }
  g.putImageData(im, 0, 0)
}
const flip = () => { if (cv) cv.style.display = 'none'; document.body.style.background = '#f00' }

function wavBlob(freq, dur) {
  const sr = 48000, n = Math.floor(sr * dur), buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf)
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * freq * i / sr) * 0.5 * 32767), true)
  return new Blob([buf], { type: 'audio/wav' })
}
const blobUrl = (f, d) => URL.createObjectURL(wavBlob(f, d || DUR))
function state(el) { return { currentTime: +el.currentTime.toFixed(2), ended: el.ended, paused: el.paused, muted: el.muted, volume: el.volume, readyState: el.readyState } }
async function playEl(el, wait) {
  let ended = false; el.addEventListener('ended', () => { ended = true })
  const t0 = Date.now()
  let err = null
  try { await el.play() } catch (e) { err = e.name }
  await sleep(wait || DUR * 1000 + 300)
  return { ...state(el), endedEvent: ended, playError: err, t0 }
}
function osc(freq, dur, ctxArg) {
  const AC = window.AudioContext || window.webkitAudioContext
  const ctx = ctxArg || new AC()
  const o = ctx.createOscillator(), g = ctx.createGain()
  o.frequency.value = freq; g.gain.value = 0.5
  o.connect(g); g.connect(ctx.destination)
  o.start(); o.stop(ctx.currentTime + dur)
  return { ctx, o }
}
const mk = (tag, src, attrs) => { const el = document.createElement(tag); Object.assign(el, attrs || {}); el.src = src; return el }

const S = {
  async blobwav() { const a = mk('audio', blobUrl(440)); document.body.append(a); return await playEl(a) },
  async mse() {
    const buf = await (await fetch('/tone.webm')).arrayBuffer()
    const ms = new MediaSource(), a = new Audio(URL.createObjectURL(ms)); document.body.append(a)
    await new Promise((r) => ms.addEventListener('sourceopen', r, { once: true }))
    const sb = ms.addSourceBuffer('audio/webm;codecs=opus')
    const parts = 4, step = Math.ceil(buf.byteLength / parts)
    for (let i = 0; i < parts; i++) { sb.appendBuffer(buf.slice(i * step, (i + 1) * step)); await new Promise((r) => sb.addEventListener('updateend', r, { once: true })) }
    ms.endOfStream()
    return await playEl(a)
  },
  async osc() { const { ctx } = osc(440, DUR); const s0 = ctx.state; await sleep(DUR * 1000 + 300); return { ctxState: s0, ctxStateEnd: ctx.state } },
  async xo_nocors() { const a = mk('audio', 'http://localhost:' + B + '/tone.wav'); document.body.append(a); return await playEl(a) },
  async xo_cors() { const a = mk('audio', 'http://localhost:' + B + '/tone.wav?cors', { crossOrigin: 'anonymous' }); document.body.append(a); return await playEl(a) },
  async dyn_audio() { await sleep(500); const a = new Audio(blobUrl(440)); return await playEl(a) }, // detached element, never in the DOM
  async dyn_video() { await sleep(500); const v = mk('video', blobUrl(440)); document.body.append(v); return await playEl(v) },
  async autoplay_attr() { const a = mk('audio', blobUrl(440), { autoplay: true }); document.body.append(a); await sleep(DUR * 1000 + 300); return state(a) },
  async mix() { osc(440, DUR); const a = mk('audio', blobUrl(880)); document.body.append(a); return await playEl(a) },
  async iframe(kind) {
    const f = document.createElement('iframe')
    f.allow = 'autoplay'
    if (kind === 'sandbox' || kind === 'sandbox_late') { f.setAttribute('sandbox', 'allow-scripts'); const d = kind === 'sandbox' ? 0 : 700; f.srcdoc = '<script>setTimeout(()=>{const c=new AudioContext(),o=c.createOscillator();o.frequency.value=440;o.connect(c.destination);o.start();setTimeout(()=>o.stop(),1400);parent.postMessage({done:true,state:c.state},"*")},' + d + ')</script>' }
    else f.src = (kind === 'same' ? 'http://127.0.0.1:' : 'http://localhost:') + B + '/page.html?child=1&s=osc'
    const done = new Promise((r) => addEventListener('message', (e) => r(e.data), { once: true }))
    document.body.append(f)
    const r = await Promise.race([done, sleep(5000).then(() => ({ timeout: true }))])
    await sleep(DUR * 1000 + 300)
    return r
  },
  async iframe_same() { return S.iframe('same') }, async iframe_oopif() { return S.iframe('oopif') }, async iframe_sandbox() { return S.iframe('sandbox') }, async iframe_sandbox_late() { return S.iframe('sandbox_late') },
  async freeze() { // page hardens prototypes right after our injected script ran
    const AC = window.AudioContext
    Object.freeze(AudioNode.prototype); Object.freeze(HTMLMediaElement.prototype); Object.freeze(AudioContext.prototype)
    Object.defineProperty(window, 'AudioContext', { value: AC, writable: false, configurable: false })
    const a = mk('audio', blobUrl(440)); document.body.append(a); osc(440, DUR)
    return await playEl(a)
  },
  async manyctx() {
    const n = +(Q.get('n') || 60), ctxs = []; let firstErr = null
    for (let i = 0; i < n; i++) { try { const c = new AudioContext(); osc(200 + i, 0.5, c); ctxs.push(c) } catch (e) { firstErr = firstErr || (e.name + ': ' + e.message); break } }
    await sleep(600)
    return { created: ctxs.length, firstErr, running: ctxs.filter((c) => c.state === 'running').length }
  },
  // latency: silence first (recorder already running), then bunyi + warna merah pada instan yang sama.
  async latency() {
    const via = Q.get('via') || 'osc'
    let a = null, ctx = null
    if (via === 'osc') { const AC = window.AudioContext; ctx = new AC(); await ctx.resume().catch(() => {}); const o = ctx.createOscillator(); o.frequency.value = 440; const g = ctx.createGain(); g.gain.value = 0; o.connect(g); g.connect(ctx.destination); o.start(); window.__g = g; window.__ctx = ctx }
    else { a = mk('audio', blobUrl(440, 4)); document.body.append(a); a.muted = false }
    // warm-up so the bus exists and is running before T0
    if (via === 'osc') { window.__g.gain.value = 0 } else { a.play().then(() => a.pause()).catch(() => {}) }
    await sleep(1500)
    const T0 = Date.now()
    if (via === 'osc') window.__g.gain.setValueAtTime(0.5, window.__ctx.currentTime); else a.play()
    flip()
    await sleep(1200)
    return { T0 }
  },
  async hold() { // long-running tone for cpu / throttling tests; page.stop() ends it
    const mode = Q.get('src') || 'osc'
    if (mode === 'osc') window.__h = osc(440, 600)
    else if (mode === 'el') { const a = mk('audio', blobUrl(440, 30), { loop: true }); document.body.append(a); await a.play(); window.__h = a }
    return { started: Date.now() }
  },
  async noisy() { // music-like: tones + noise so bitrate numbers are not a pure-sine best case
    const AC = window.AudioContext, ctx = new AC(), n = ctx.sampleRate * 3, b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0)
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * 0.15
    const s = ctx.createBufferSource(); s.buffer = b; const g = ctx.createGain(); g.gain.value = 1; s.connect(g); g.connect(ctx.destination); s.start()
    osc(440, 3, ctx); osc(1320, 3, ctx); await sleep(3300); return { ok: true }
  },
  async silent() { await sleep(500); return { ok: true } },
}
window.runScenario = (name) => S[name]()
if (Q.get('child') === '1') S[Q.get('s')]().then((r) => parent.postMessage({ done: true, ...r }, '*'))
window.stopHold = () => { try { if (window.__h && window.__h.o) window.__h.o.stop(); else if (window.__h) window.__h.pause() } catch (e) {} }
`
