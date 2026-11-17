// Limits shared by Central's camera tools (server) and the board that obeys them (client).
/** The canvas's own zoom range (App.canvas.tsx minZoom / maxZoom; a policy test keeps them equal). */
export const CAMERA_MIN_ZOOM = 0.01
export const CAMERA_MAX_ZOOM = 2
/** Largest pan of one call, in screen pixels (about one screen; a farther node is reached with `focus`). */
export const CAMERA_PAN_MAX_PX = 5000
/** After a human canvas gesture Central's camera and board switches wait this long (Follow's pause, centralFollow.ts). */
export const USER_ACTIVE_PAUSE_MS = 10_000

/** `v` forced into [min, max]; NaN falls to `min`. */
export const clampTo = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, Number.isNaN(v) ? min : v))
