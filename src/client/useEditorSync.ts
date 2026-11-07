import { useEffect, useRef, useState } from 'react'
import type { FsResult, FsVersion } from '../shared/fsContract'
import { dirName, isUnder, remapPath } from './editorFile'
import { onFsEvent } from './fsEvents'
import type { EditorConflict } from './useEditorFile'

/** Jeda sebelum `stat` karena event `dirty` direktori (watcher memicu beruntun saat satu simpan). */
export const SYNC_STAT_DEBOUNCE_MS = 300

const logStat = (p: string) => (err: unknown): void => console.error(`editor sync: stat failed for ${p}`, err)

type StatFn = (path: string) => Promise<FsResult<{ version: FsVersion }>>

export interface EditorSyncArgs {
  filePath: string
  /** true = file teks (Monaco); false = viewer biner (versi lewat URL). */
  text: boolean
  /** Terapkan path baru ke data node (mekanisme update node yang sama dengan rename judul). */
  setPath: (path: string) => void
  /** Keadaan buffer saat ini (hanya bermakna untuk `text`). */
  snapshot: () => { dirty: boolean; saving: boolean; version: FsVersion }
  reload: (onlyIfClean: boolean) => Promise<void>
  flagConflict: (c: EditorConflict) => void
  stat: StatFn
}

/**
 * Editor ikut perubahan file dari luar node: rename (path + judul ikut), hapus (bar/notice) dan tulis
 * remote (bersih -> auto-reload, dirty -> konflik; buffer pengguna TIDAK dibuang). Sinyal `dirty`
 * milik direktori dicek dengan satu `stat` ber-debounce dan dibandingkan dengan versi yang dikenal,
 * sehingga gema simpan milik node ini sendiri tidak memicu apa pun.
 * Mengembalikan `missing` (viewer biner: file hilang) dan `viewVersion` (berubah = viewer dimuat ulang).
 */
export function useEditorSync(args: EditorSyncArgs): { missing: boolean; viewVersion: FsVersion | undefined } {
  const ref = useRef(args)
  ref.current = args
  const [missing, setMissing] = useState(false)
  const [viewVersion, setViewVersion] = useState<FsVersion | undefined>(undefined)
  // Versi terakhir yang dikenal untuk viewer biner (teks memakai versi buffer lewat `snapshot`).
  const seenRef = useRef<FsVersion | undefined>(undefined)

  /** Terapkan versi disk `v`; no-op bila sama dengan yang sudah dikenal. */
  const apply = (v: FsVersion | undefined): void => {
    const a = ref.current
    if (a.text) {
      const s = a.snapshot()
      if (s.saving || (v !== undefined && v === s.version)) return
      if (s.dirty) a.flagConflict({ kind: 'version', current: v })
      else void a.reload(true)
      return
    }
    if (v === undefined || v === seenRef.current) return
    const first = seenRef.current === undefined
    seenRef.current = v
    if (!first) setViewVersion(v)
  }

  const markMissing = (): void => {
    if (ref.current.text) ref.current.flagConflict({ kind: 'missing' })
    else setMissing(true)
  }

  /** `stat` file ini lalu bandingkan; ENOENT = terhapus, galat lain diabaikan (sinyal berikut mengulang). */
  const check = async (): Promise<void> => {
    const path = ref.current.filePath
    const r = await ref.current.stat(path)
    if (path !== ref.current.filePath) return
    if (r.ok) {
      setMissing(false)
      apply(r.version)
    } else if (r.code === 'ENOENT') markMissing()
  }

  // Baseline viewer biner: versi saat dibuka, supaya perubahan pertama tidak dikira "pertama kali lihat".
  useEffect(() => {
    if (args.text) return
    seenRef.current = undefined
    void ref.current.stat(ref.current.filePath).then((r) => {
      if (r.ok && seenRef.current === undefined) seenRef.current = r.version
    })
  }, [args.text])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = onFsEvent((e) => {
      const p = ref.current.filePath
      if (!p) return
      if (e.kind === 'renamed') {
        const next = e.from ? remapPath(p, e.from, e.path) : null
        if (next && next !== p) {
          setMissing(false)
          ref.current.setPath(next)
        }
      } else if (e.kind === 'deleted') {
        if (isUnder(p, e.path)) markMissing()
      } else if (e.kind === 'written') {
        if (e.origin === 'remote' && e.path === p) (ref.current.text ? apply(undefined) : void check().catch(logStat(p)))
      } else if (e.kind === 'dirty' && (e.path.replace(/\/+$/, '') || '/') === dirName(p)) {
        clearTimeout(timer)
        timer = setTimeout(() => void check().catch(logStat(p)), SYNC_STAT_DEBOUNCE_MS)
      }
    })
    return () => {
      off()
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- semua lewat ref; langganan sekali per node
  }, [])

  return { missing, viewVersion }
}
