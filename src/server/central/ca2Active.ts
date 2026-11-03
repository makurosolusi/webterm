// Process-wide handle of the booted Central Agent v2 (WS-19). Kept apart from `ca2Boot` so chat and
// route modules can read it without importing the bun:sqlite-backed boot graph (vitest runs under node).
import type { Ca2Handle } from './ca2Boot'

let active: Ca2Handle | null = null
/** The handle created by `bootCa2`, or null while CA2 is inert. */
export function activeCa2(): Ca2Handle | null { return active }
/** Replaces or clears the process handle (boot and tests). */
export function setActiveCa2(handle: Ca2Handle | null): void { active = handle }
