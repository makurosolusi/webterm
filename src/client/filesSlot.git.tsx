// Slot git (WS-FM-08): huruf status + warna token VS Code di listing node files. Marks dimuat dari
// `git-status` hanya bila server mengaktifkan GIT_STATUS, dan dimuat ulang pada fsEvents.
import { useEffect, useReducer } from 'react'
import type { FileMeta, GitMark } from '../shared/fsContract'
import './filesSlot.git.css'
import { capabilities, gitStatus } from './fsClient'
import { onFsEvent } from './fsEvents'
import type { Decoration, FilesSlot, FilesSlotCtx } from './filesSlots'

/** Jeda gabung rentetan event (banyak mutasi/dirty berturut-turut) menjadi satu muat ulang. */
const GIT_REFRESH_DEBOUNCE_MS = 250

const TITLE: Record<GitMark, string> = { M: 'Modified', A: 'Added', D: 'Deleted', U: 'Untracked', R: 'Renamed', C: 'Conflict' }
/** Folder hanya diberi titik: huruf milik file; warna = mark terkuat isinya. */
const FOLDER_BADGE = '•'

/** Marks per node (kunci = nodeId; dua node pada dir sama tak saling menghapus saat unmount). */
const store = new Map<string, Map<string, GitMark>>()

/** Muat marks untuk `ctx.dir` dan muat ulang saat ada event fs; kosong bila git dimatikan server. */
function useGitMarks(ctx: FilesSlotCtx): void {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const { nodeId, dir } = ctx
  useEffect(() => {
    let alive = true
    let seq = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let enabled = false
    const load = async () => {
      const mine = ++seq
      const r = await gitStatus(dir)
      if (!alive || mine !== seq) return
      // Kunci NFC: macOS mengembalikan nama NFD dari readdir, git (precomposeunicode) NFC.
      store.set(nodeId, new Map(r.ok ? Object.entries(r.marks).map(([k, v]) => [k.normalize('NFC'), v]) : []))
      bump()
    }
    // Fail-closed: galat apa pun saat menanyakan kemampuan/memuat = tanpa dekorasi, tidak merusak listing.
    void Promise.resolve().then(() => capabilities()).then((c) => {
      if (!alive || !c.git) return
      enabled = true
      return load()
    }).catch((err) => console.warn(`filesSlot.git: gagal memuat status git untuk node ${nodeId}`, err))
    const off = onFsEvent(() => {
      if (!enabled) return
      clearTimeout(timer)
      timer = setTimeout(() => void load(), GIT_REFRESH_DEBOUNCE_MS)
    })
    return () => { alive = false; clearTimeout(timer); off(); store.delete(nodeId) }
  }, [nodeId, dir])
}

function decorate(entry: FileMeta, ctx: FilesSlotCtx): Decoration | undefined {
  const mark = store.get(ctx.nodeId)?.get(entry.name.normalize('NFC'))
  if (!mark) return undefined
  return entry.dir
    ? { badge: FOLDER_BADGE, title: `Contains changes (${TITLE[mark]})`, className: `files-git--${mark}` }
    : { badge: mark, title: TITLE[mark], className: `files-git--${mark}` }
}

export const gitSlot: FilesSlot = { id: 'git', useSlot: useGitMarks, decorate }
