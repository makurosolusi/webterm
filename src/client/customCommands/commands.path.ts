// Display helpers for the custom-commands panel.

/** A path with the home prefix shown as `~` (the client does not know the server's home: the usual layouts). */
export function shortenHome(path: string): string {
  return path.replace(/^(?:\/Users\/[^/]+|\/home\/[^/]+|\/root)(?=\/|$)/, '~')
}

/** Session items grouped by folder, first-seen order. */
export function groupByDir(items: readonly { name: string; dir: string }[]): { dir: string; names: string[] }[] {
  const out = new Map<string, string[]>()
  for (const i of items) out.set(i.dir, [...(out.get(i.dir) ?? []), i.name])
  return [...out].map(([dir, names]) => ({ dir, names }))
}
