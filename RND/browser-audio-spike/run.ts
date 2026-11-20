// SPIKE: jangan merge ke produk. Orkestrasi: `bun RND/browser-audio-spike/run.ts [--n=5] [--only=matrix,autoplay,latency,bitrate,cpu,throttle,failures]`
// Output: tabel markdown ke stdout + RND/browser-audio-spike/results.json. Semua proses & folder sementara dibersihkan di akhir.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchBrowser, startServers, cleanupTmp, sleep, type Browser, type Servers } from './harness'
import { makeMedia } from './media'
import * as S from './suites'
import * as P from './perf'

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1]
const n = Number(arg('n') ?? 5)
const only = new Set((arg('only') ?? 'matrix,autoplay,latency,bitrate,cpu,throttle,failures').split(','))
const FLAGS = ['--mute-audio', '--autoplay-policy=no-user-gesture-required'] // --mute-audio: the server speakers must stay silent; autoplay flag only on the "flag" browsers
const results: Record<string, S.Row[]> = {}

function table(title: string, rows: S.Row[]) {
  if (!rows.length) return
  console.log(`\n### ${title}\n`)
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))]
  console.log(`| ${cols.join(' | ')} |\n|${cols.map(() => '---').join('|')}|`)
  for (const r of rows) console.log(`| ${cols.map((c) => String(r[c] ?? '')).join(' | ')} |`)
  results[title] = rows
}

const media = await makeMedia()
const sv: Servers = startServers(media.wav, media.webm)
const live: Browser[] = []
const launch = async (headless: boolean, extra: string[]) => { const b = await launchBrowser({ headless, extra, proxyPort: sv.proxy }); live.push(b); return b }
const ctx = (b: Browser, label: string): S.Ctx => ({ b, sv, n, label })

try {
  const headful = await launch(false, FLAGS)
  const hf = ctx(headful, 'headful-offscreen')
  table('Availability', [await P.availability(hf)])
  if (only.has('matrix')) {
    table('Source matrix, headful offscreen, mode=mes', await S.matrix(hf, 'mes'))
    table('Source matrix, headful offscreen, mode=cap', await S.matrix({ ...hf, n: Math.min(n, 3) }, 'cap'))
    table('Baseline without injection (element side effects)', await S.baseline(hf))
  }
  if (only.has('failures')) table('AudioContext count limit', await S.manyCtx(hf))
  if (only.has('latency')) {
    const rows: S.Row[] = []
    rows.push(await P.latency(hf, 'osc', { mode: 'mes', timeslice: 100 }))
    rows.push(await P.latency(hf, 'osc', { mode: 'mes', timeslice: 250 }))
    rows.push(await P.latency(hf, 'el', { mode: 'mes', timeslice: 100 }))
    rows.push(await P.latency(hf, 'el', { mode: 'cap', timeslice: 100 }))
    table('Latency and A/V skew (ms; positive skew = audio chunk arrives AFTER the frame)', rows)
  }
  if (only.has('bitrate')) table('Chunk rate and bitrate (music-like content)', await P.bitrate(hf))
  if (only.has('cpu')) table('CPU / RSS of the Chromium process tree (8 s windows)', await P.cpu(hf, headful.pid))
  if (only.has('throttle')) table('Hidden / frozen node behaviour (headful offscreen)', await P.throttle(hf))
  headful.kill(); await sleep(1500)

  if (only.has('matrix') || only.has('throttle')) {
    const headless = await launch(true, FLAGS)
    const hl = ctx(headless, 'headless')
    table('Availability', [await P.availability(hl)])
    if (only.has('matrix')) table('Source matrix, headless, mode=mes', await S.matrix({ ...hl, n: Math.min(n, 3) }, 'mes'))
    if (only.has('throttle')) table('Hidden / frozen node behaviour (headless)', await P.throttle(hl))
    headless.kill(); await sleep(1500)
  }
  if (only.has('autoplay')) {
    const plain = await launch(false, ['--mute-audio']) // exactly webterm's flags + mute, no autoplay flag
    table('Autoplay policy (webterm flags + --mute-audio only)', await S.autoplay({ ...ctx(plain, 'headful-offscreen, no autoplay flag'), n: Math.min(n, 3) }))
    plain.kill(); await sleep(1500)
    const flagged = await launch(false, FLAGS)
    table('Autoplay policy (with --autoplay-policy=no-user-gesture-required)', await S.autoplay({ ...ctx(flagged, 'headful-offscreen, autoplay flag'), n: Math.min(n, 3) }))
    flagged.kill(); await sleep(1500)
  }
} finally {
  for (const b of live) b.kill()
  sv.stop()
  await sleep(1500)
  cleanupTmp()
  writeFileSync(join(import.meta.dir, 'results.json'), JSON.stringify(results, null, 1))
}
process.exit(0)
