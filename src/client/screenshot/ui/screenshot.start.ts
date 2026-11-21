// The one entry point: the ⌘K command, its shortcut and the Dock button all call `startScreenshot`;
// the mounted `ScreenshotHost` listens. Kept tiny so the command registry can import it without the UI.
const listeners = new Set<() => void>()

/** Start a screenshot (or, when one is already open, toggle it closed). */
export function startScreenshot(): void {
  listeners.forEach((l) => l())
}

/** Host side: called on every start request; returns the unsubscribe. */
export function onScreenshotStart(l: () => void): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}
