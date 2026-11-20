# browser-video-spike

SPIKE: jangan merge ke produk. Measures screencast smoothness (see `docs/decisions/browser-video-smoothness.md`).
It launches Chromium with the product flags and `CdpClient`, runs the product screencast params and the real viewer hub (flow control) against local pages only (canvas 60 fps, local `<video>`, static). No Playwright, no web.

Host (needs Bun; `ffmpeg` optional, without it the page records its own clip with MediaRecorder):

    bun RND/browser-video-spike/run.ts [--bin=PATH] [--duration=8] [--reps=2] [--suite=quick|full] [--only=substr] [--out=file.json] [--quiet]

- `quick` (default, ~3 min): video through headless, headless+`--disable-gpu`, hub/naive flow at 50 ms RTT, q40, headful.
- `full` (~35 min, 15 s x 3): adds canvas, static, q60/dpr2/`everyNthFrame`2, RTT 0/20/50/100, swiftshader. Run only when asked.
- Without `--bin`: `$WEBTERM_BROWSER_BIN`, `/usr/local/bin/chrome`, then the managed Chrome for Testing.
- stdout = one JSON document (rows: server fps min/med/max, gap p50/p95/p99, gaps >100/>250 ms, client fps and gaps, JPEG KB, `chromiumCpuPct`/`bunCpuPct` as % of one core, hold/ack ms). Progress goes to stderr.

Container (image has bun + Chromium at `/usr/local/bin/chrome`, repo at `/app`; headless is chosen automatically without DISPLAY):

    docker cp RND/browser-video-spike <container>:/app/RND/
    docker exec <container> bun /app/RND/browser-video-spike/run.ts --bin=/usr/local/bin/chrome --duration=8 --reps=2 > video.json

CPU is read from `/proc` on Linux (no `ps` needed). Profile and HOME are temp dirs removed at exit; nothing touches `~/.webterm-server`.
