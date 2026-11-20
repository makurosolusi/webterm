# browser-audio-spike

SPIKE: jangan merge ke produk. Measures in-page audio capture for the browser node (`docs/decisions/browser-audio.md` has the findings).

Run: `bun RND/browser-audio-spike/run.ts [--n=5] [--only=matrix,autoplay,latency,bitrate,cpu,throttle,failures]`
(prints markdown tables, writes `results.json` next to it). Quick infra check: `bun RND/browser-audio-spike/smoke.ts [scenario]`.

Needs: Bun, `ffmpeg` with libopus on PATH (decodes the captured WebM/Opus and generates the test tone), and the managed Chrome for Testing
(or `WEBTERM_BROWSER_BIN`). Nothing here touches `~/.webterm-server` data: profile and HOME are `mktemp` dirs removed at exit.

No external browser driver: Chromium is launched with the repo's `launchChromium`/`buildChromiumArgs` and driven with the repo's `CdpClient`.
Only local pages served from `127.0.0.1` (two origins, `127.0.0.1` and `localhost`, reached through a tiny forwarding proxy because webterm forces one).

Files: `harness.ts` (launch, servers, ffmpeg+FFT analysis), `inject.source.ts` (the injected capture script), `testpage.ts` (test page), `case.ts` (one test case),
`suites.ts` (functional), `perf.ts` (measurements), `run.ts` (orchestration), `media.ts` (generated tones).
