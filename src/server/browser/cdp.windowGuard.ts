// Structural fence at the single CDP send point: no command may surface, focus or move a real OS window of the user's machine.
// Why: on macOS the node windows are deliberately minimized (chromium.flags.ts windowPlacement); `Target.activateTarget` or
// `Page.bringToFront` restores and focuses them, which breaks canvas containment (docs/decisions/canvas-containment.md).

/** Methods that raise, focus or move an OS window; refused for every caller (host, agent allowlist, probes). */
export const WINDOW_SURFACING_METHODS: readonly string[] = ['Target.activateTarget', 'Page.bringToFront', 'Browser.setWindowBounds']

const CREATE_TARGET = 'Target.createTarget'

/** Reason a command must not be sent, or undefined when it is safe. `createTarget` must be a background, unfocused, own window. */
export function windowSurfacingViolation(method: string, params?: object): string | undefined {
  if (WINDOW_SURFACING_METHODS.includes(method)) return `${method} would surface or move an OS window`
  if (method === CREATE_TARGET) {
    const p = (params ?? {}) as Record<string, unknown>
    if (p.background !== true || p.focus !== false || p.newWindow !== true) return `${method} must set newWindow:true, background:true and focus:false`
  }
  return undefined
}
