// SPIKE: jangan merge ke produk. Screencast smoothness bench (docs/decisions/browser-video-smoothness.md).
// bun RND/browser-video-spike/run.ts [--bin=PATH] [--duration=15] [--reps=3] [--suite=quick|full] [--only=substr] [--out=file.json]
// Progress goes to stderr; stdout is one compact JSON document (rows = one per launch x scenario x config).
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeVideo, startServers } from './pages'
import type { Scenario } from './pages'
import { launchBrowser, med, pct, runOnce } from './measure'
import type { Cfg, Launch, RunResult } from './measure'

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const flag = (k: string) => process.argv.includes(`--${k}`)
const home = process.env.HOME ?? ''
const BIN = arg('bin', process.env.WEBTERM_BROWSER_BIN ?? (existsSync('/usr/local/bin/chrome') ? '/usr/local/bin/chrome'
  : `${home}/.webterm-server/browser/chrome-for-testing/158.0.8127.36/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`))
const SUITE0 = arg('suite', 'quick')
const DURATION = +arg('duration', SUITE0 === 'full' ? '15' : '8')
const REPS = +arg('reps', SUITE0 === 'full' ? '3' : '2')
const SUITE = arg('suite', 'quick')
const ONLY = arg('only', '')
const log = (s: string) => process.stderr.write(`${s}\n`)

const base: Cfg = { name: 'q80 dpr1 nth1 ack-on-receipt', quality: 80, dpr: 1, nth: 1, flow: 'server', rtt: 0 }
const C = (name: string, o: Partial<Cfg>): Cfg => ({ ...base, name, ...o })
const flows = (rtts: number[]) => rtts.flatMap((rtt) => [C(`hub rtt${rtt}`, { flow: 'hub', rtt }), C(`wait rtt${rtt}`, { flow: 'wait', rtt })])
const hasDisplay = process.platform !== 'linux' || !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)

// The Docker image is headless with no GPU: `headless+disable-gpu` is the closest simulation of it.
const BASE_LAUNCH: Launch = { name: 'headless+disable-gpu', headless: true, extra: ['--disable-gpu'] }
const OTHER_LAUNCH: Launch[] = [
  ...(hasDisplay ? [{ name: 'headful-offscreen', headless: false, extra: [] }] : []),
  { name: 'headless', headless: true, extra: [] },
  { name: 'headless+swiftshader', headless: true, extra: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
]
interface Job { launch: Launch; scenarios: Scenario[]; cfgs: Cfg[] }
const jobs: Job[] = SUITE === 'full'
  ? [
    { launch: BASE_LAUNCH, scenarios: ['static', 'canvas', 'video'], cfgs: [base] },
    { launch: BASE_LAUNCH, scenarios: ['canvas', 'video'], cfgs: [
      C('q60', { quality: 60 }), C('q40', { quality: 40 }), C('dpr2', { dpr: 2 }), C('nth2', { nth: 2 }), ...flows([0, 20, 50, 100])] },
    ...OTHER_LAUNCH.map((launch) => ({ launch, scenarios: ['canvas', 'video'] as Scenario[], cfgs: [base] })),
  ]
  : [ // triage (~3 min at 8 s x 2): headless vs headless+disable-gpu, flow control at 50 ms RTT, q40, headful
    { launch: { name: 'headless', headless: true, extra: [] }, scenarios: ['video'], cfgs: [base] },
    { launch: BASE_LAUNCH, scenarios: ['video'], cfgs: [base, C('hub rtt50', { flow: 'hub', rtt: 50 }), C('wait rtt50', { flow: 'wait', rtt: 50 }), C('q40', { quality: 40 })] },
    ...(hasDisplay ? [{ launch: { name: 'headful-offscreen', headless: false, extra: [] }, scenarios: ['video' as Scenario], cfgs: [base] }] : []),
  ]

const dir = mkdtempSync(join(tmpdir(), 'wt-vid-media-'))
const video = makeVideo(dir)
const servers = startServers(video)
const rowsOut: unknown[] = []
const cleanup: Array<() => void> = [() => servers.stop(), () => rmSync(dir, { recursive: true, force: true })]
const exit = () => { for (const c of cleanup) try { c() } catch { /* best effort */ } }
process.on('SIGINT', () => { exit(); process.exit(130) })

try {
  for (const job of jobs) {
    log(`launch ${job.launch.name}`)
    const b = await launchBrowser(BIN, servers.proxy, job.launch)
    cleanup.push(() => b.kill())
    const version = (await b.cdp.send<{ product: string }>('Browser.getVersion')).product
    try {
      for (const scenario of job.scenarios) for (const cfg of job.cfgs) {
        const label = `${job.launch.name} | ${scenario} | ${cfg.name}`
        if (ONLY && !label.includes(ONLY)) continue
        const runs: RunResult[] = []
        for (let i = 0; i < REPS; i++) { runs.push(await runOnce(b, `http://127.0.0.1:${servers.port}/${scenario}`, scenario, cfg, scenario === 'static' ? Math.min(DURATION, 8) : DURATION)); log(`  ${label} rep${i + 1} fps=${runs[i].server.fps} client=${runs[i].client?.fps ?? '-'}`) }
        const pool = runs.flatMap((r) => r.gaps)
        const spread = (f: (r: RunResult) => number) => { const v = runs.map(f); return { med: med(v), min: Math.min(...v), max: Math.max(...v) } }
        const r1 = (x: number) => Math.round(x * 10) / 10
        rowsOut.push({
          launch: job.launch.name, scenario, cfg: cfg.name, reps: REPS, seconds: DURATION, chromium: version,
          serverFps: spread((r) => r.server.fps), gapMs: { med: r1(med(pool)), p95: r1(pct(pool, 0.95)), p99: r1(pct(pool, 0.99)) },
          over100PerRep: spread((r) => r.server.over100), over250PerRep: spread((r) => r.server.over250),
          clientFps: runs[0].client ? spread((r) => r.client!.fps) : null,
          clientGapP95: runs[0].client ? spread((r) => r.client!.p95) : null, clientOver100PerRep: runs[0].client ? spread((r) => r.client!.over100) : null,
          jpegKB: med(runs.map((r) => r.jpegKB)), chromiumCpuPct: spread((r) => r.chromiumCpu), bunCpuPct: spread((r) => r.bunCpu),
          holdMs: runs[0].holdMs ? { med: med(runs.map((r) => r.holdMs!.med)), p95: med(runs.map((r) => r.holdMs!.p95)) } : null,
          ackMs: runs[0].ackMs ? { med: med(runs.map((r) => r.ackMs?.med ?? NaN)), p95: med(runs.map((r) => r.ackMs?.p95 ?? NaN)) } : null,
          page: runs.map((r) => r.page),
        })
      }
    } finally { b.kill() }
  }
} finally { exit() }

const doc = JSON.stringify({ bin: BIN, platform: `${process.platform}/${process.arch}`, cores: navigator.hardwareConcurrency, videoSource: servers.videoSource, suite: SUITE, rows: rowsOut })
if (arg('out', '')) await Bun.write(arg('out', ''), doc)
if (!flag('quiet')) console.log(doc)
