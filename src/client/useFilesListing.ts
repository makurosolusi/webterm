// Memuat isi direktori untuk FilesNode: daftar membawa direktori asalnya (G-04), listing kosong
// diklasifikasi lewat induknya, dan 401 dibedakan dari "tak terjangkau" lewat probe `stat`.
import { useEffect, useRef, useState } from 'react'
import type { FileMeta } from '../shared/fsContract'
import * as fsClient from './fsClient'
import { classifyEmptyListing, parentDir, type EmptyListingVerdict } from './fileBrowse'
import { isAuthFail } from './filesView'

export type ListingVerdict = EmptyListingVerdict | 'auth'
const NO_ENTRIES: FileMeta[] = []

/** Entri sebuah direktori; `withMeta` (urut size/mtime) memakai list-v2, selain itu `list` biasa. */
async function fetchEntries(dir: string, withMeta: boolean): Promise<FileMeta[]> {
  if (withMeta) {
    const r = await fsClient.listV2(dir)
    if (r.ok) return r.entries
  }
  return (await fsClient.list(dir)).map((e) => ({ ...e, ignored: !!e.ignored }))
}

/**
 * `onLanded` dipanggil setelah listing mendarat (dipegang lewat ref supaya identitasnya tak memicu
 * fetch ulang). `version` dinaikkan pemanggil untuk refresh/retry manual.
 */
export function useFilesListing(cwd: string, version: number, withMeta: boolean, onLanded: () => void) {
  const [listing, setListing] = useState<{ dir: string; entries: FileMeta[] }>({ dir: '', entries: [] })
  const [fetching, setFetching] = useState(true)
  const [verdict, setVerdict] = useState<ListingVerdict | null>(null)
  const landed = useRef(onLanded)
  landed.current = onLanded

  useEffect(() => {
    let alive = true
    setFetching(true)
    void (async () => {
      const got = await fetchEntries(cwd, withMeta)
      if (!alive) return
      setListing({ dir: cwd, entries: got })
      let next: ListingVerdict | null = null
      if (got.length === 0) {
        // Listing kosong ambigu secara kontrak (lihat `classifyEmptyListing`): tanya INDUK.
        const parent = parentDir(cwd)
        const pe = parent === cwd ? null : await fsClient.list(parent)
        if (!alive) return
        next = classifyEmptyListing(cwd, pe)
        if (next === 'unreachable') {
          // `list` fail-open menyembunyikan status; `stat` membawa pesan "HTTP 401" bila token ditolak.
          const probe = await fsClient.stat(cwd)
          if (!alive) return
          if (!probe.ok && isAuthFail(probe)) next = 'auth'
        }
      }
      setVerdict(next)
      setFetching(false)
      landed.current()
    })()
    return () => { alive = false }
  }, [cwd, version, withMeta])

  // Begitu `cwd` berpindah, daftar lama TIDAK boleh tampil — klik pada entri lama akan membuka
  // `childPath(cwdBaru, namaLama)` (G-04).
  const current = listing.dir === cwd
  return { entries: current ? listing.entries : NO_ENTRIES, loading: fetching || !current, verdict }
}
