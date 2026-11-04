// Node display-name helpers shared by the canvas (client/nodeIdentity.ts) and the server spawn path
// (server/spawn/agentSpawn.ts), so both sides name agents the same way.

/** `base` if free among `used`, else `base (2)`, `base (3)`… (case-insensitive). */
export function uniqueTitle(base: string, used: Iterable<string>): string {
  const taken = new Set([...used].map((n) => n.trim().toLowerCase()))
  if (!taken.has(base.trim().toLowerCase())) return base
  for (let i = 2; ; i++) {
    const next = `${base} (${i})`
    if (!taken.has(next.toLowerCase())) return next
  }
}
