/** Caps for `keybindings`: it arrives over HTTP, so a hostile body cannot bloat the stored row. */
export const KEYBINDINGS_LIMITS = { entries: 200, idLength: 128, chordLength: 64 }

/** Keep only `id → chord | null` entries within `KEYBINDINGS_LIMITS`; anything else is dropped. */
export function normalizeKeybindings(v: unknown): Record<string, string | null> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Record<string, string | null> = {}
  for (const [id, chord] of Object.entries(v)) {
    if (Object.keys(out).length >= KEYBINDINGS_LIMITS.entries) break
    if (!id || id.length > KEYBINDINGS_LIMITS.idLength) continue
    if (chord === null || (typeof chord === 'string' && chord.trim() && chord.length <= KEYBINDINGS_LIMITS.chordLength)) out[id] = chord
  }
  return out
}
