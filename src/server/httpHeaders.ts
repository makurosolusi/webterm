// Node request headers arrive as string | string[] | undefined. These two helpers are the only
// places that decide what a repeated header means.
export type HeaderBag = Record<string, string | string[] | undefined>

/** Case-insensitive lookup. A repeated (array) header counts as absent: a single value is required. */
export function headerValue(headers: HeaderBag | undefined, name: string): string | undefined {
  if (!headers) return undefined
  const want = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== want) continue
    return typeof value === 'string' ? value : undefined
  }
  return undefined
}

/** Already-fetched header value: first entry when repeated (array), otherwise as-is. */
export function firstHeader(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw
}
