// SPIKE: jangan merge ke produk. Cek cepat infrastruktur: `bun RND/browser-audio-spike/smoke.ts [scenario...]`
import { launchBrowser, startServers, cleanupTmp, sleep } from './harness'
import { runCase, hasTone } from './case'
import { makeMedia } from './media'

const names = process.argv.slice(2)
const media = await makeMedia()
const sv = startServers(media.wav, media.webm)
const b = await launchBrowser({ headless: false, extra: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'], proxyPort: sv.proxy })
try {
  for (const n of names.length ? names : ['blobwav', 'osc']) {
    for (const mode of ['mes', 'cap'] as const) {
      const r = await runCase(b, sv, { scenario: n, inject: { mode, timeslice: 100 }, screencast: true, autoAttach: true })
      console.log(n, mode, JSON.stringify(hasTone(r)), JSON.stringify(r.page), r.err ?? '', r.cap.logs, 'attached', JSON.stringify(r.cap.attached), 'chunks', r.cap.chunks.length, 'frames', r.cap.frames.length, 'starts', JSON.stringify(r.cap.starts.map((s) => s.state)))
    }
  }
} finally { b.kill(); sv.stop(); await sleep(500); cleanupTmp() }
process.exit(0)
