# Browser compare overlay: decisions

QC compares two pages of one browser node (for example mobile 390 vs desktop 1280) without switching tabs. Pattern: Figma
"overlay", Chrome DevTools rendering diffs, Responsively. Entry: split menu, "Compare panes…" (disabled below two panes).

## Capture: read the pane's own canvas
Split panes already paint every streamed frame on their `<canvas>` (frame pixels = canvas pixels). A capture is one
`getImageData` on that canvas, with no server round trip, no `Page.captureScreenshot` and no extra load on the page.
The server `screenshot` verb stays for agents (JPEG, lease rules) and was not reused: it costs a CDP call per tab and
would wake or disturb the page. Consequence: only panes on screen can be compared, the picture is what the stream last
delivered (side panes stream at about 5 fps and 0.6 scale when 3+ panes are shown), and a tab that is asleep or crashed
has no frame, so the overlay says so and offers Wake (the same reload the pane uses).
Captures are taken on open and on "Refresh capture" only. There is no polling.

## Sizes
Different sizes (device presets) are normalized: `fit` scales both to the Base width (aspect kept, nearest neighbour);
"Compare at actual size" keeps pixels unscaled on a canvas as large as the larger side. Working size is capped at 1600px
on the longest side. The warning "Sizes differ (...); scaled to fit" shows while `fit` is active.

## Difference
`diffImages` (`diff.ts`, pure) marks a pixel when its largest channel distance, alpha included, exceeds the tolerance
(0-50 percent of 255, default 5 to hide anti-aliasing and JPEG noise). Two fully transparent pixels are equal. The area a
shorter capture does not cover counts as different. The heavy loop runs in a Web Worker (`diff.worker.ts`); without
Workers it runs in row slices over animation frames (`diff.run.ts`). Both are cancellable ("Computing..." + Cancel), and a
new tolerance or capture aborts the previous run. Closing the overlay terminates the worker.

## Export
"Save comparison as PNG" composes the current view (swipe split, onion blend or difference over a dimmed base) from the
same pixels the overlay shows; the object URL is revoked right after the download. "Copy" appears only where
`ClipboardItem` exists; a denied permission becomes a plain message.

## Not done
- Entry in the pane header menu: the header file is owned by another change; the split menu is the single entry for now.
- Side-by-side mode: panes already are side by side.
- Real-canvas rendering and diff speed on a weak machine are not covered by the jsdom tests (no canvas there).
