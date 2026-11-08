// Slot git (WS-FM-08): huruf status + warna token VS Code di listing node files, plus branch +
// ahead/behind di footer (VS Code status bar). Marks dimuat dari `git-status` hanya bila server
// mengaktifkan GIT_STATUS, dan dimuat ulang pada fsEvents (server juga mengirim `fsdirty` saat
// index/HEAD repo berubah, jadi commit/add/checkout ikut menyegarkan).
import { useEffect, useReducer } from 'react'
import type { FileMeta, GitBranch, GitMark } from '../shared/fsContract'
import './filesSlot.git.css'
import { capabilities, gitStatus } from './fsClient'
import { onFsEvent } from './fsEvents'
import type { Decoration, FilesSlot, FilesSlotCtx } from './filesSlots'

/** Jeda gabung rentetan event (banyak mutasi/dirty berturut-turut) menjadi satu muat ulang. */
const GIT_REFRESH_DEBOUNCE_MS = 250

/** Row tooltip (VS Code wording, short form). */
const TITLE: Record<GitMark, string> = { M: 'Modified', A: 'Added', D: 'Deleted', U: 'Untracked', R: 'Renamed', C: 'Conflict', I: 'Ignored' }
/** Folder tooltip for its strongest child mark (ignored never rolls up). */
const FOLDER_TITLE: Record<Exclude<GitMark, 'I'>, string> = {
  M: 'Contains modified items', A: 'Contains added items', D: 'Contains deleted items',
  U: 'Contains untracked items', R: 'Contains renamed items', C: 'Contains conflicts',
}
/** Visible letter; VS Code shows `!` for every conflict status (extensions/git Resource.getStatusLetter). */
const BADGE: Record<Exclude<GitMark, 'I'>, string> = { M: 'M', A: 'A', D: 'D', U: 'U', R: 'R', C: '!' }
/** Folder hanya diberi titik: huruf milik file; warna = mark terkuat isinya. */
const FOLDER_BADGE = '•'

/** `parents` = folders that have their own child records (so their mark is a rollup, not their own). */
interface NodeGit { marks: Map<string, GitMark>; parents: Set<string>; branch?: GitBranch }
/** State per node (kunci = nodeId; dua node pada dir sama tak saling menghapus saat unmount). */
const store = new Map<string, NodeGit>()

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
      const marks = new Map<string, GitMark>(r.ok ? Object.entries(r.marks).map(([k, v]) => [k.normalize('NFC'), v]) : [])
      const parents = new Set([...marks.keys()].map((k) => k.slice(0, Math.max(0, k.lastIndexOf('/')))))
      store.set(nodeId, { marks, parents, branch: r.ok ? r.branch : undefined })
      bump()
    }
    // Fail-closed: galat apa pun saat menanyakan kemampuan/memuat = tanpa dekorasi, tidak merusak listing.
    void Promise.resolve().then(() => capabilities()).then((c) => {
      if (!alive || !c.git) return
      enabled = true
      return load()
    }).catch((err) => console.warn(`filesSlot.git: failed to load git status for node ${nodeId}`, err))
    const off = onFsEvent(() => {
      if (!enabled) return
      clearTimeout(timer)
      timer = setTimeout(() => void load(), GIT_REFRESH_DEBOUNCE_MS)
    })
    return () => { alive = false; clearTimeout(timer); off(); store.delete(nodeId) }
  }, [nodeId, dir])
}

/** Mark of row `rel` (path relative to cwd, any depth). git reports an untracked or ignored folder as one
 *  record ("? new/"), so rows inside it inherit that mark, as in VS Code; a folder with child records
 *  carries only a rollup (server-side, strongest child) and is never inherited from. */
function markAt(s: NodeGit, rel: string): GitMark | undefined {
  const own = s.marks.get(rel)
  if (own) return own
  for (let i = rel.lastIndexOf('/'); i > 0; i = rel.lastIndexOf('/', i - 1)) {
    const up = rel.slice(0, i)
    const m = s.marks.get(up)
    if ((m === 'U' || m === 'I') && !s.parents.has(up)) return m
  }
  return undefined
}

function decorate(entry: FileMeta, ctx: FilesSlotCtx): Decoration | undefined {
  const s = store.get(ctx.nodeId)
  if (!s) return undefined
  // Fallback: the listing's check-ignore flag (a record may be cut by the server's mark limit).
  const mark = markAt(s, entry.name.normalize('NFC')) ?? (entry.ignored ? 'I' : undefined)
  if (!mark) return undefined
  const className = `files-git--${mark}`
  // VS Code: ignored is colour only, no badge.
  if (mark === 'I') return { title: TITLE.I, className }
  return entry.dir
    ? { badge: FOLDER_BADGE, title: FOLDER_TITLE[mark], className }
    : { badge: BADGE[mark], title: TITLE[mark], className }
}

/** VS Code `syncTooltip` wording (extensions/git repository.ts). */
function syncTitle(b: GitBranch): string {
  const up = b.upstream ?? ''
  if (!b.ahead) return `Pull ${b.behind} commits from ${up}`
  if (!b.behind) return `Push ${b.ahead} commits to ${up}`
  return `Pull ${b.behind} and push ${b.ahead} commits between ${up}`
}

/** Branch (or detached short oid) + VS Code `syncLabel` `${behind}↓ ${ahead}↑`; nothing outside a repo. */
function footer(ctx: FilesSlotCtx) {
  const b = store.get(ctx.nodeId)?.branch
  if (!b) return null
  const label = b.branch ?? b.head
  return (
    <span className="files-git-foot">
      <span className="files-git-foot__item" title={label}>
        <span className={`codicon ${b.branch ? 'codicon-git-branch' : 'codicon-git-commit'}`} aria-hidden="true" />
        {label}
      </span>
      {(b.ahead > 0 || b.behind > 0) && (
        <span className="files-git-foot__item" title={syncTitle(b)}>
          <span className="codicon codicon-sync" aria-hidden="true" />
          {`${b.behind}↓ ${b.ahead}↑`}
        </span>
      )}
    </span>
  )
}

export const gitSlot: FilesSlot = { id: 'git', useSlot: useGitMarks, decorate, footer }
