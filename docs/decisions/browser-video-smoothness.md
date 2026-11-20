# Browser node: video smoothness over the screencast

Status: triage measured 2026-11-20 (Chrome for Testing 158.0.8127.36, macOS arm64, 8 cores, machine shared with other workers). Container numbers NOT measured yet.
Evidence: `RND/browser-video-spike/` (`bun RND/browser-video-spike/run.ts`, see its README; local pages only, no real web). The spike drives the product's launch flags, `CdpClient`, `screencastParams` and the real `createViewerHub` (the flow-control code) behind a simulated client RTT.

## Symptom

Video (YouTube, others) in a browser node "feels choppy". Chromium runs on the server (Docker: headless, no GPU, shared 4 vCPU), is screencast as JPEG over CDP, and the canvas draws each frame.

## How the frame path works (read from code, not assumed)

1. Chromium frame -> `pushFrame` -> hub `fanout`. The host acks Chromium **on receipt** (`browserWs.viewers.ts`), not when the client acks. Chromium's production is therefore not tied to the client round trip.
2. Per client the hub keeps one newest pending frame per pane and a gate of `MAX_FRAMES_IN_FLIGHT` un-acked frames; the client acks after it decoded (`createImageBitmap`, off the main thread) and drew. Older decode results are dropped (`order.painted`).
3. So per-client throughput = window / RTT, and a window of 2 was the only limit between server and client.

## Measured (8 s x 2 reps, spread min-max; median gap in ms, ">100" = gaps above 100 ms per rep)

Local 1080p30 VP9 video, `headless+disable-gpu` unless noted:

| Scenario | server fps | gap p95/p99 ms | >100 ms | Chromium CPU (% core) | bun CPU | JPEG KB |
|---|---|---|---|---|---|---|
| headless (GPU) | 29.9 | 38.5 / 54.8 | 1 | 32 | 1.6 | 43 |
| headless + `--disable-gpu` (container sim) | 29.9-30.1 | 34.7 / 37 | 0 | 51 | 1.1 | 44 |
| same, JPEG quality 40 | 29.9-30.1 | 35 / 36 | 0 | 50 | 1.0 | 25 |
| headful offscreen | 29.9-30 | 36 / 47 | 0 | 39 | 1.6 | 40 |
| hub, RTT 50 ms (video 30 fps) | client 30 | 34.5 | 0 | 51 | 1.5 | 44 |
| naive "Chromium ack waits for client", RTT 50 | client 30 | 34.7 | 0 | 51 | 1.3 | 44 |

60 fps canvas animation through the product hub (`headless+disable-gpu`), client-side paint rate, the window as it was (2) vs now (6):

| RTT | window 2 (before) | window 6 (after) |
|---|---|---|
| 0 ms | 60.1 | 60.1 |
| 20 ms | 60.1 | 60.1 |
| 50 ms | 39.0 (p95 gap 26 ms) | 60.1 |
| 100 ms | 19.9 (p95 gap 82 ms) | 59.4 (p95 gap 21 ms) |

Page truth: the video decoded 30 fps with 0 % dropped frames in every row; the canvas page rendered 60.2 fps. An interrupted longer run (3 reps x 15 s) agreed: 60 fps server-side at q60/q40/dpr2, 30 fps with `everyNthFrame=2`.

## Proven roots

- **Window of 2 caps a client at 2/RTT fps** (above: 39 fps at 50 ms, 20 fps at 100 ms, 60 fps content). 30 fps video is unaffected until RTT > ~66 ms; 60 fps content from RTT > ~33 ms. A tunnel/LAN client over 66 ms sees video fall below 30 fps and, because newest-wins drops frames in bursts, irregular spacing. This is the one cause the numbers show.

## Not proven / disproven on this machine

- (a) CPU too weak: software render raised Chromium CPU from 32 % to 51 % of one core at 1080p30 here, with no missed frames. Not shown to saturate; the 4 shared vCPU container may differ. **Unmeasured.**
- (b) Chromium ack gated on the client: disproven for the product (acks on receipt; the naive variant gives the same numbers at 50 ms because the window is 1 round trip and 30 fps needs 1/33 ms).
- (c) Quality/size: q40 halves JPEG bytes (44 -> 25 KB) with no fps/CPU change here; dpr2 still 60 fps. Bandwidth only matters on a slow link: **unmeasured**.
- (d) Client decode/backlog: code reading only (async bitmap decode, drops older frames, no queue growth). No jsdom-measurable logic added.
- (e) WS backpressure: `bufferedAmount` guard exists (1 MB); not stressed.
- (f) GL flags: swiftshader/headless variants are in `--suite=full`, not run.
- (g) side-tab screencasts competing: not measured.

## Action

Changed `MAX_FRAMES_IN_FLIGHT` from 2 to a value derived in `browser.contract.ts` from `SCREENCAST_FPS_TARGET` (60) x `FRAME_RTT_BUDGET_MS` (100) = 6, so a client within 100 ms RTT can take full 60 fps. Why this root: it is the only measured limit and it sits exactly where throughput is decided. Cost: up to 6 frames (about 270 KB at 45 KB) may be queued toward a slow client; the existing 1 MB `bufferedAmount` guard and newest-wins pending frame bound that, and Chromium is unaffected (acked on receipt). Tests: `browserWs.backpressure.test.ts` (fake clock: window 2 gives ~20 fps at 100 ms, the new window >= 58 fps at 60/100 ms and >= 29 fps at 30/150 ms).

Not done (no proof): adaptive quality, `everyNthFrame`, GL flags, client rAF coalescing. If the container run shows Chromium CPU near saturation (frame gaps >100 ms with `chromiumCpuPct` near 100 x vCPU), the next steps are adaptive `quality`/`everyNthFrame` driven by inter-frame gap; until then the container cause is **unknown** and the container symptom is not claimed fixed.
