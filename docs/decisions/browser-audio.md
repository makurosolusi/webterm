# Browser node audio: in-page capture (spike result)

Status: spike, measured 2026-11-20 (Chrome for Testing 158.0.8127.36, macOS arm64, 8 cores, machine shared with other workers). No product code changed.
Evidence: `RND/browser-audio-spike/` (`bun RND/browser-audio-spike/run.ts`; raw numbers in `results.json`).

## Context

The browser node is Chromium on the server, screencast as JPEG over CDP to the canvas. There is no audio capture, transport or player, so a video
(e.g. YouTube) plays silently. Chromium runs with `--mute-audio` (planned) so nothing plays on the server's speakers.

## Design tested

1. `Page.addScriptToEvaluateOnNewDocument` injects a script into every frame (OOPIF and sandboxed iframes need extra work, see below).
2. Per realm, lazily (nothing is created until the first audio source appears): one `AudioContext` bus -> `MediaStreamAudioDestinationNode` -> `MediaRecorder('audio/webm;codecs=opus', timeslice)`.
3. Sources: `HTMLMediaElement.prototype.play` + a capture-phase `play` listener, then either `createMediaElementSource(el)` (mode `mes`) or `el.captureStream()` (mode `cap`);
   WebAudio: `AudioNode.prototype.connect(destination)` also connects to a per-context tee -> `MediaStreamDestination` -> `createMediaStreamSource` on the bus.
4. Each chunk goes out through `Runtime.addBinding` / `Runtime.bindingCalled` as JSON `{frameKey, seq, pageTime, base64}`.
5. The harness reused `launchChromium`, `buildChromiumArgs`, `windowPlacement` and `CdpClient` (no Playwright/Puppeteer). Extra flags added only in the spike: `--mute-audio`, `--use-mock-keychain`, `--password-store=basic`, and `--autoplay-policy=no-user-gesture-required` where stated.
6. Verification is content-based: chunks are decoded with ffmpeg and the dominant frequency is found with an FFT. Pass = 440 Hz peak (+-12 Hz) and window RMS above 0.05 (a 0.5 amplitude tone gives about 0.35).

## Results

n = 5 per row (headful offscreen, mode `mes`); n = 3 for `cap`, headless and autoplay rows. "pass" = tone found in the server-side decoded stream.

| Scenario | headful `mes` | headful `cap` | headless `mes` | Notes |
|---|---|---|---|---|
| a1 `<audio>` blob: WAV | 5/5 | 3/3 | 3/3 | 440 Hz, RMS 0.358 |
| a2 real MSE (MediaSource, WebM/Opus, 4 appends) | 5/5 | 3/3 | 3/3 | the closest model of a YouTube player |
| b WebAudio oscillator | 5/5 | 3/3 | 3/3 | via the connect() tee |
| c1 cross-origin `<audio>`, no CORS | **0/5 silent** | **0/3 silent** | 0/3 | recorder runs (3.5 kbps) but peak RMS is 0 |
| c2 cross-origin `<audio>`, `crossorigin=anonymous` + ACAO | 5/5 | 3/3 | 3/3 | |
| d1 iframe same-site (other port) | 5/5 | 3/3 | 3/3 | page-level inject covers it |
| d2 iframe cross-site (OOPIF) + `Target.setAutoAttach` | 5/5 | 3/3 | 3/3 | needs `Page.enable` on the child session (without it nothing ran) |
| d3 same, no auto-attach | **0/5** | 0/3 | 0/3 | no inject in the OOPIF |
| d4 sandboxed iframe, audio at its first script | **0/5** | 0/3 | 0/3 | child attaches with `waitingForDebugger=false`: race lost |
| d5 sandboxed iframe, audio 700 ms later | 5/5 | 3/3 | 3/3 | RMS 0.715 only because that test osc has gain 1 |
| e1 `new Audio(blob)` never in DOM, started late | 5/5 | 3/3 | 3/3 | |
| e2 `<video>` appended late | 5/5 | 3/3 | 3/3 | |
| e3 `autoplay` attribute, no `play()` | 5/5 | 3/3 | 3/3 | |
| g mix osc 440 + `<audio>` 880 | 5/5 | 3/3 | 3/3 | both peaks present in one stream |
| f1 page freezes prototypes after inject | 5/5 | 3/3 | 3/3 | natives are captured first |
| f2 strict CSP (`default-src 'none'; script-src 'self'`) | 5/5 | 3/3 | 3/3 | CDP inject and bindings are not subject to CSP |

Availability (both modes): `MediaRecorder.isTypeSupported('audio/webm;codecs=opus')` true, `audio/ogg;codecs=opus` false, `captureStream` and `MediaStreamAudioDestinationNode` present,
MSE WebM/Opus true. `AudioContext.sampleRate` was 44100 and baseLatency 5.8 ms on this Mac (follows the output device; Opus resamples to 48 kHz).

### Side effects on the page

Element scenarios (a1, a2, c1, c2, e1, e2, f1, f2) with capture: `ended` fired, `currentTime` reached 1.4 s, `muted=false`, `volume=1`, `paused` correct and `play()` resolved, 5/5 for `mes` and 3/3 for `cap`,
identical to the same pages without injection (3/3). A `<video>` kept advancing `currentTime`. Page-visible behaviour is unchanged, but `mes` permanently reroutes the element's
output into our graph (fine with `--mute-audio`, would silence a non-muted browser).
Silent pages pay nothing: no bus is created, CPU 1.7% vs 1.7% of one core.

### Autoplay (n = 3, headful offscreen, webterm flags + `--mute-audio` only)

| Case | `<audio>.play()` | AudioContext | autoplay attr |
|---|---|---|---|
| no gesture, default policy | `NotAllowedError`, no capture, bus suspended | suspended, no capture | element blocked, bus never created |
| real click first (`Input.dispatchMouseEvent`) | plays, captured 3/3, bus running | 3/3 | 3/3 |
| with `--autoplay-policy=no-user-gesture-required` | 3/3 | 3/3 | 3/3 |

`Emulation.setAutoplayPolicy` does not exist in this Chrome build (CDP error -32601), so there is no per-page switch. The capture never changed the page's own autoplay outcome; a real
click forwarded as CDP input is a genuine user activation and lets both the page and our bus start. Not tested: the bus being created while suspended and resumed by a later click (the inject has a resume-on-gesture listener, unverified).

### Latency and A/V skew (n = 10, headful offscreen; same machine, same clock)

T0 = page `Date.now()` at the moment the tone starts and the screen flips to solid red. Audio = arrival of the first chunk whose decoded prefix contains the tone. Visual = first screencast frame after T0 that is a solid frame (detected by JPEG size).

| Source | timeslice | audio median / p95 (ms) | frame median / p95 (ms) | skew median / p95 / range (ms) |
|---|---|---|---|---|
| WebAudio osc (tee path) | 100 | 181 / 211 | 40 / 48 | +143 / 163 / 138..163 |
| WebAudio osc (tee path) | 250 | 300 / 306 | 40 / 47 | +258 / 274 / 221..274 |
| `<audio>` `mes` | 100 | 83 / 93 | 42 / 43 | +42 / 56 / 40..56 |
| `<audio>` `cap` | 100 | 212 / 215 | 42 / 47 | +170 / 173 / 155..173 |

Positive skew = audio arrives after the matching frame. Binding transit (page `Date.now()` at send to server receive): median 1 ms, p95 1-2 ms; base64 encode in page: 0-1 ms. So the latency is
recorder/graph buffering (about 120 ms chunk cadence, plus the extra MediaStream hop in the tee and `cap` paths), not the CDP path. The `mes` element path is the best measured. Client playback buffer is on top of these numbers and was not measured.

### Cost

- Chunk cadence: `timeslice=100` gives 8.3 chunks/s (inter-arrival p95 123 ms), `250` gives 3.3/s (p95 303 ms). The recorder does not honour 100 ms exactly.
- Bitrate (music-like noise + tones, n = 5): default 125 kbps (about 1.8 KB/chunk at 100 ms); `audioBitsPerSecond` 64000 gives 64 kbps; 32000 gives 32.5 kbps. Add 33% for base64 in the binding string (167 / 85 / 43 kbps on the CDP socket).
- CPU, Chromium process tree, 8 s windows, n = 4, percent of one core (median): silent page 1.7 without vs 1.7 with inject; osc tone 3.4 vs 8.4 (+5.0); `<audio>` loop 3.1 vs 7.8 `mes` (+4.7) and 7.3 `cap` (+4.2).
  Machine was shared, so absolute values are noisy (run-to-run range about 2 points).
- RSS of the tree: 614-663 MB across all conditions with run-to-run spread (about 490-770 MB) larger than any difference; no memory delta is claimable from this data.

### Failure modes and limits

- AudioContext count: creating 100 contexts never threw, with or without inject; 49 were `running` in both cases (median, n = 3), the rest not running. Whether the bus changes the cap and whether all 49 would be captured was not verified.
- Hidden/background: the offscreen (minimized on macOS) node reports `visibilityState=visible`. Chunks kept flowing at 8.3-8.5/s and timers at 20/s under baseline and with focus emulation off, in headful and headless.
  `Page.setWebLifecycleState frozen` had no effect (still visible, chunks and timers kept going). A really hidden tab was not tested (it needs a second tab in the same window or surfacing an OS window, forbidden by `cdp.windowGuard.ts`).
- Each realm (main frame, each OOPIF, sandboxed iframe) records its own stream; they are not mixed. The tested pages produced one stream because only one realm played.
- Webterm's current args do not set an autoplay policy; see above.

## Proven limits

1. Cross-origin media without CORS is silent in both `mes` and `cap` (spec behaviour of tainted media). A plain `<video src=https://cdn/...mp4>` loaded without `crossorigin` will not be heard. MSE/blob sources (what YouTube-style players use) are same-origin and work.
2. OOPIF iframes need `Target.setAutoAttach` (flatten, `waitForDebuggerOnStart`) plus, on each child session, `Page.enable`, `Runtime.enable`, `Runtime.addBinding`, the same inject and `Runtime.runIfWaitingForDebugger`. Without it, cross-site iframe audio is lost.
3. Sandboxed iframes attach as a target that is not paused, so audio started by the iframe's first script is missed; audio started later is captured.
4. A page that starts audio before any user gesture is blocked by Chrome's default policy exactly as without capture; a forwarded user click unblocks it.
5. Audio is about 40 ms (best) to 260 ms (tee, 250 ms slices) behind the screencast frame of the same event, before client buffering.

## Not proven

- DRM/EME (Widevine) content: not tested (encrypted audio may be unreadable by `createMediaElementSource`/`captureStream`; Chrome for Testing has no Widevine anyway).
- Real YouTube or any real site: not tested (no web browsing allowed). Player-specific behaviour (own AudioContext graphs, `WebAudio` hijacks, `MediaSession`) is unverified.
- Client playback: no WebSocket frame, client decoder, jitter buffer or human A/V-sync perception was built or measured. Safari/Firefox support for MSE WebM/Opus playback of MediaRecorder chunks is unverified.
- Headless latency/CPU (only capture correctness was run headless), hidden-tab behaviour, long sessions (minutes to hours: recorder drift, memory), many simultaneous nodes, page detection of the patch (`AudioContext.toString()` etc. exposes it), and the bus resumed by a later click.
- Linux (the server OS in production/Docker): only macOS was measured; audio-service differences are possible, but the capture path is in the renderer so it should not depend on the audio device.

## Recommendation: GO, with conditions

Capture works for every source that matters here (MSE/blob media, `new Audio()`, WebAudio, same-site and OOPIF iframes with auto-attach) with correct frequency content, no page-visible side effects, no cost for silent pages and about +5 points of one core
while audio plays. The two known holes (no-CORS cross-origin media, a sandbox race) are narrow. Conditions: ship as an opt-in-by-use feature (per node mute/unmute, default muted until the user clicks the speaker), use `mes` with `timeslice` 100 and
`audioBitsPerSecond` 64000 (about 85 kbps on the wire), do not delay video for sync, and re-measure on Linux/Docker and with a real YouTube-class page by the owner before enabling by default.

## Full design (if go)

Order of work (each step ships with tests; branch `feature/browser-audio`):

1. **Contract** `src/shared/browser.contract.ts`: add `FRAME_TYPE_AUDIO = 3` (binary: type, idLen, nodeId, `streamKey`, seq, server `t` in ms, payload; old clients ignore unknown types as for `FRAME_TYPE_TIMED`), capability `audio: true` in the browser capability/version handshake, client messages `audio:set {nodeId, on}` and a per-node `audioActive` state flag. Env `WEBTERM_BROWSER_AUDIO` registered in the env registry (default on, kill switch).
2. **Injected script** `browser.audio.inject.ts` (the spike source, `mes` mode only, constants for binding name, timeslice, bitrate in the contract) and `browser.audio.inject.test.ts` (jsdom/fake graph: patch order, lazy bus, freeze safety).
3. **Host capture** `browserHost.audio.ts`: on each page target `Runtime.enable` (already used by the console panel), `Runtime.addBinding`, `Page.addScriptToEvaluateOnNewDocument`; OOPIF/iframe children through the existing `Target.setAutoAttach` path in `browserHost.shield.ts` (merge, do not duplicate) with `Page.enable` on the child; decode `bindingCalled` into audio frames with a per-target stream key. Add the new CDP method names to the table in `cdp.client.ts` (the table test forbids literals elsewhere).
4. **Chromium flags** `chromium.flags.ts`: add `--mute-audio`; no autoplay flag (a forwarded click is a real gesture); update `chromium.flags.test.ts`.
5. **Transport** `browserWs` audio send with its own backpressure (drop oldest beyond about 1 s of chunks per client, never block the video frames), only to clients that sent `audio:set on`; capture is paused (script `postMessage`-free toggle through `Runtime.evaluate` of `__wtAudioPause()`) when no client listens, so the CPU cost is paid only while someone listens.
6. **Client player** `src/client/.../browserAudio.player.ts`: `AudioContext` created or resumed on the speaker-button click (a gesture); `MediaSource` + `audio/webm;codecs=opus` SourceBuffer per stream key (fallback decode path to verify per browser); keep about 150 ms buffer, drop to live edge when behind more than 500 ms; `muted` state per node persisted in layout.
7. **Node chrome** speaker button on the browser node header: states off / on / audio-detected (pulse when a stream exists and the node is muted), all states per instance; accessible name, keyboard.
8. **A/V compensation**: stamp chunks with the server arrival time and frames already carry sequence numbers/latency; the client does not delay video (interaction latency matters more); it plays audio as soon as buffered. The spike skew (40-260 ms) is reported in a debug overlay for tuning, and a delay-video option can be added only if user testing shows it is needed.
9. **Lifecycle**: node paused/hidden/discarded/closed -> stop streams, close the client `SourceBuffer`, recorder is dropped with the page; navigation creates a new stream key (client resets); crash/respawn re-injects through the normal target setup; tab switch routes the focused tab's streams only (others muted server-side).
10. **Policy tests** (`scripts/test.policy.manifest.ts` registration required): audio CDP methods only in `cdp.client.ts` table; the inject source contains no network call and no `eval`; the audio frame type is registered once in the contract; `--mute-audio` present in `buildChromiumArgs`; canvas-containment test unchanged (no new window or tab).
11. **Docs** this file updated with measured Linux/real-site numbers; README/protocol docs for the new frame type; CHANGELOG entry.

Estimated size: about 10 new files (inject, host audio, ws audio, player, speaker button, tests) and 6 touched (contract, flags, cdp table, shield attach, browserWs, node chrome), roughly 900-1200 lines including tests.
