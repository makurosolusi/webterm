# The canvas background can be an animated image or a video

Code: `src/server/canvasBackground.sniff.ts`, `canvasBackground.store.ts` (`streamCanvasUpload`),
`canvasBackground.serve.ts` (Range), `src/server/routes/canvasBackground.routes.ts`,
`src/shared/canvasBackground.schema.ts`, `src/client/CanvasBackgroundLayer.tsx`,
`CanvasBackgroundVideo.tsx`, `canvasBackground.media.ts`, `canvasBackground.motion.ts`,
`canvasBackground.precheck.ts`, `CanvasBackgroundControls.tsx`.

## Context

The owner wants a calm, moving background (rice fields, a meadow) while working. The wallpaper already
accepted PNG, JPEG, WebP and GIF. This adds animated WebP (works as is) and video.

## Decisions

1. **Formats and caps.** Images (including animated WebP and GIF) up to 25 MB; video as MP4 (H.264) or
   WebM up to 100 MB. No video ships with the app (licence and size). Free sources are named in the
   Settings hint (Pexels, Pixabay), without links.
2. **The bytes decide the type.** The server sniffs magic bytes: MP4 = `ftyp` at offset 4 with a known
   brand (`isom iso2 avc1 mp41 mp42 M4V `), WebM = EBML magic with DocType `webm` in the first 64 bytes,
   animated WebP = RIFF/WEBP + `VP8X` chunk with the animation flag. The stored name is
   `<uuid>.<ext-from-sniff>`; the client's name and Content-Type are never used, so an mp4 named `.png`
   is stored (and served) as mp4, and anything unknown is 415. Files are stored as uploaded, never
   re-encoded. The server records `imageAnimated` in the background setting (video, animated WebP, GIF)
   so the UI knows the Playback select applies without reading the file again.
3. **Uploads stream to disk.** A 100 MB body is never held in memory: it goes to `<uuid>.part` (mode
   0600) in the backgrounds dir, the first 64 bytes are sniffed, the per-type cap is enforced while
   streaming (over the cap: stop writing, delete the partial, drain the rest, answer 413 `too_large`),
   then an atomic rename to the final name. Boot GC removes `.part` files a crash left behind. The code
   lives in `canvasBackground.store.ts`, the module the body-reader policy test
   (`route.core.body.bun.test.ts`) already allows; the router's 256 KiB `ctx.readBody` cap only applies to
   routes that call it, and this route does not.
4. **HTTP Range is required, not an optimisation.** The native macOS app runs WebKit, which refuses to
   play a `<video>` whose server ignores Range; seeking and looping need it everywhere. The read endpoint
   answers 206 with `Content-Range` for `bytes=a-b`, `bytes=a-` and `bytes=-n`, 416 for an unsatisfiable
   range, 200 for a multi-range or malformed header (allowed by RFC 9110), and HEAD. It streams from
   disk. Headers: `Accept-Ranges: bytes`, `X-Content-Type-Options: nosniff`, `Cache-Control: private,
   max-age=31536000, immutable` (the id holds a uuid, a replacement gets a new id).
5. **Auth is the same as for the image.** `<video src>` is a same-origin request, so the `wt_ui` session
   cookie authenticates it exactly like `<img>`/CSS (see `ui-session-cookie.md`). The app itself serves no
   `Content-Security-Policy` (only MCP app frames do), so no `media-src` was needed.
6. **Playback mode** `always | focused | off`, default **focused**: a wallpaper that keeps moving in a
   window nobody looks at only burns battery. Focused pauses on `document.hidden` or window blur
   (`document.hasFocus()` is re-read on `visibilitychange`, `focus`, `blur`, so focus moving into an
   iframe does not count as leaving) and resumes on return. Off pauses and shows the first frame.
   Animated images cannot be paused, so when they must not move the layer swaps in one still frame drawn to
   a canvas (capped at 1920 px wide, JPEG); if no still can be made, no picture is shown rather than a
   moving one.
7. **Reduced motion.** With `prefers-reduced-motion: reduce` the effective mode is Off unless the owner
   explicitly chose Always. (A stored `focused` cannot be told apart from the default, so under reduced
   motion focused behaves as off; Settings says so next to the select.)
8. **Video is always muted** (autoplay needs it and a wallpaper needs no sound) and **never blurred**: a
   CSS blur re-filters every frame, which is expensive for a decorative layer. Dim and the gradient overlay
   still apply (they are cheap compositing layers). Blur on an animated image is allowed, with a note that
   it uses more CPU.
9. **Failure is quiet.** A video that errors, or whose `play()` is rejected (other than an abort from our
   own `pause()`), falls back to the default look and Settings says "This video can't be played here. Use an
   H.264 MP4 or a WebM file." Before uploading, the client loads the file's metadata in a hidden element and
   refuses what the browser cannot play; a video wider than 1920 px or over 50 MB only warns.
10. **Cleanup.** One `<video>` per layer; on unmount or replacement it is paused, `src` emptied and
    `load()` called so the decoder releases its buffers. The canvas and the Settings preview are two layers,
    so two elements exist while Settings is open.

## Not verified by automated tests

jsdom plays no media. Tests cover attributes, the play/pause calls, events, state and the server over a
real HTTP socket; they do not prove that a real browser or the native WebKit app decodes, loops smoothly,
sends the cookie on media requests, or stays within a CPU budget.
