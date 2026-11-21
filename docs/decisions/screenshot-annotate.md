# Screenshot with annotations: a local, LightShot-style capture of the webterm page

## Decision

"Canvas: Take Screenshot" (Dock camera button, command palette, `Mod+Shift+S`) freezes the webterm page, lets the user
select an area, draw on it, and copy or save it. Behaviour imitates LightShot: darkened frozen page, drag to select,
dashed frame with eight handles and a `1056x330` size label at its top-left, a vertical tool rail beside the selection and a
horizontal action bar under it.

- **Target is the webterm page, not the OS screen.** A web page cannot see other windows without the screen-capture
  permission prompt, and the point is annotating what is on the canvas (terminals, browser nodes, diffs). The same engine
  as the agent's `canvas.screenshot` (`src/client/canvasShot.ts`) clones the DOM; the overlay root carries
  `data-shot-ignore`, so it is never in the picture.
- **Frozen frame, captured before the overlay mounts**, so nothing moves while the user selects. A short blocking
  "Capturing the page…" pill (also ignored by the capture) covers the clone time.
- **Full resolution.** The frame is captured at device pixel ratio (capped at 8192 px per side and 32 Mpx total). Shapes live
  in image pixels, the preview is only a scaled view, and the export redraws crop + shapes at full resolution.
- **No upload, share, search or print.** LightShot offers them; webterm deliberately does not. The image may hold terminal
  output, tokens or code, and the owner's rule is that nothing leaves the browser except by an explicit labelled act
  (`canvas-containment.md`). Copy goes to the clipboard, Save is a download of a local object URL, and
  `screenshot.policy.test.ts` fails the build on `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, `window.open`,
  `target="_blank"` or `location.` anywhere in `src/client/screenshot/`, including `ui/`.
- **One surface.** The command `canvas.screenshot` (`commandRegistry.defaults.ts`) calls `startScreenshot()`; the Dock button
  (`Dock.modes.tsx`) calls the same function. `ScreenshotHost` (mounted in `App.hosts.tsx`) is the only listener.
- **Zero config.** No setting. Last color, stroke width and text size are remembered in `localStorage`
  (`webterm.screenshot.prefs`; guarded, a failure only loses the memory).

## Shortcut

| Key | Does |
| --- | --- |
| `Mod+Shift+S` (rebindable, command `canvas.screenshot`) | start; while open, close (toggle) |
| `Enter` | select the whole window |
| Arrows / `Shift`+arrows on the focused selection | move / resize it by 10 image px |
| `Mod+Z`, `Mod+Shift+Z` (`Mod+Y`) | undo, redo |
| `Mod+C` | copy the PNG, then close |
| `Mod+S` | save the PNG, then close |
| `Esc` | close; while typing text, cancel that text only |
| Text field: `Enter` adds, `Shift+Enter` new line | |

`Mod` is Cmd on macOS and Ctrl elsewhere. Why `Mod+Shift+S`: it is the "Save As" chord family, no registry command or fixed
binding uses it (`commandRegistry.test.ts` checks the full list), and it is not an OS or browser capture key (macOS uses
Cmd+Shift+3/4/5, Windows Win+Shift+S). Firefox binds it to its own screenshot; webterm cancels the keydown, and a browser that reserves the chord for itself can be answered by rebinding the command in Keyboard Shortcuts.
Inside the overlay `Mod+C`, `Mod+S` and `Mod+Z` are used as in LightShot; they are not registry commands because they only
exist while the overlay is open, and the overlay is modal (it stops every keydown, so no global shortcut fires behind it).

## States (`shot.ui.machine.ts`, a pure reducer)

`idle -> capturing -> selecting -> selected -> copying | saving -> idle` ("closed" is `idle` with the frame dropped).

| From | Event | To |
| --- | --- | --- |
| idle | start | capturing (a second start in any other phase is ignored) |
| capturing | captured / captureFailed | selecting / idle + error notice |
| selecting | drag, then release at least 8 px | selected |
| selecting | release smaller, or pointer cancel | selecting (no selection) |
| selecting | Enter | selected (whole window) |
| selected | tool, color, shape, undo, redo, move, resize | selected |
| selected | copy / save | copying / saving |
| copying, saving | ok | idle + "Copied to clipboard" / "Saved <name>" |
| copying | denied, unsupported, failed | selected + error notice offering "Save as PNG" |
| saving | failed (encoding/download) | selected + error notice |
| selecting, selected | Esc, close button, shortcut again | idle |

Errors (all through the app's notice stack, `showNotice`, plus a live region in the overlay): page too large (too many
elements on screen), capture failed (both offer "Try again"), another capture running, clipboard denied or unsupported
(offers Save, keeps the work), save failed. Nothing fails silently.

## Known limits

- Only the webterm page is captured; other windows and the OS are not.
- Capture clones the DOM (`modern-screenshot`): cross-origin images/fonts it cannot fetch, and the browser nodes' live
  frames, are as faithful as the agent screenshot path is. A Radix tooltip left open by hovering may appear in the picture.
- A press outside a committed selection does nothing (LightShot would start a new selection); adjust with the handles or
  close and capture again.
- Text is a single style per item, no editing after it is added (undo and redo it).
- No animation is used, so `prefers-reduced-motion` needs no special case.
- Clipboard images need a secure context (https or localhost) and a user gesture; elsewhere the notice offers Save.
