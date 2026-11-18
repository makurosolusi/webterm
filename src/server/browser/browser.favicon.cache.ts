// In-memory favicon cache, per (profile, icon URL), least recently used first out. Bounded by entries and by bytes so a
// crawl through many sites cannot grow it; entries expire so a changed icon is picked up even without a reload.
export const FAVICON_CACHE_MAX_ENTRIES = 128
export const FAVICON_CACHE_MAX_BYTES = 2 * 1024 * 1024
export const FAVICON_CACHE_TTL_MS = 10 * 60_000

interface Entry { data: string | null; at: number }

/** `data` null = the URL was fetched and is not a usable icon (remembered so a 404 favicon is not retried on every navigation). */
export function createFaviconCache(now: () => number = Date.now) {
  const map = new Map<string, Entry>() // Map keeps insertion order: the first key is the least recently used
  let bytes = 0
  const key = (profileId: string, url: string): string => `${profileId}\n${url}`
  const size = (e: Entry): number => e.data?.length ?? 0
  const drop = (k: string): void => { const e = map.get(k); if (e) { bytes -= size(e); map.delete(k) } }
  return {
    /** undefined = not cached (or expired); null = cached as "no usable icon". */
    get(profileId: string, url: string): string | null | undefined {
      const k = key(profileId, url)
      const e = map.get(k)
      if (!e) return undefined
      if (now() - e.at > FAVICON_CACHE_TTL_MS) { drop(k); return undefined }
      map.delete(k)
      map.set(k, e) // touched: now the most recently used
      return e.data
    },
    set(profileId: string, url: string, data: string | null): void {
      const k = key(profileId, url)
      drop(k)
      const e = { data, at: now() }
      map.set(k, e)
      bytes += size(e)
      for (const old of map.keys()) {
        if (map.size <= FAVICON_CACHE_MAX_ENTRIES && bytes <= FAVICON_CACHE_MAX_BYTES) break
        if (old !== k) drop(old)
      }
    },
    size: (): number => map.size,
  }
}
export type FaviconCache = ReturnType<typeof createFaviconCache>
