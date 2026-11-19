// Opens the node's Downloads popover when a NEW download starts, closes it after the last one finished cleanly and was left alone.
// Only the node that owns the download (items are per node) and only while it is on screen; no focus is moved.
import { useEffect, useRef, useState } from 'react'
import { downloadsOfNode } from '../../shared/browser.downloads'
import type { DownloadItem, DownloadState } from '../../shared/browser.downloads'
import { AUTO_CLOSE_MS, DONE_MARK_MS, canAutoClose, freshInProgress, isShown } from './downloadsAutoOpen'

export interface AutoOpenArgs {
  nodeId: string
  items: readonly DownloadItem[]
  open: boolean
  /** The element that must be on screen for the popover to open (the toolbar control). */
  anchor: () => HTMLElement | null
  onAutoOpen: () => void
  onAutoClose: () => void
}

export function useDownloadsAutoOpen({ nodeId, items, open, anchor, onAutoOpen, onAutoClose }: AutoOpenArgs) {
  const known = useRef<Set<string> | null>(null)
  const states = useRef<Map<string, DownloadState>>(new Map())
  const session = useRef<Set<string>>(new Set())
  const cb = useRef({ anchor, onAutoOpen, onAutoClose })
  cb.current = { anchor, onAutoOpen, onAutoClose }
  const [auto, setAuto] = useState(false)
  const [engaged, setEngaged] = useState(false)
  const [doneMark, setDoneMark] = useState(false)

  useEffect(() => {
    const mine = downloadsOfNode(items, nodeId)
    const prev = known.current
    const before = states.current
    known.current = new Set(mine.map((i) => i.id)) // first sight is history: it never opens anything
    states.current = new Map(mine.map((i) => [i.id, i.state]))
    if (prev === null) return
    if (!open && mine.some((i) => before.get(i.id) === 'inProgress' && i.state === 'completed')) setDoneMark(true)
    const fresh = freshInProgress(prev, items, nodeId)
    if (!fresh.length) return
    fresh.forEach((i) => session.current.add(i.id))
    const el = cb.current.anchor()
    if (open || !el || !isShown(el)) return // already open = the same popover keeps updating
    setAuto(true)
    cb.current.onAutoOpen()
  }, [items, nodeId, open])

  useEffect(() => {
    if (open) { setDoneMark(false); return }
    setAuto(false); setEngaged(false); session.current.clear()
  }, [open])
  useEffect(() => {
    if (!doneMark) return
    const t = setTimeout(() => setDoneMark(false), DONE_MARK_MS)
    return () => clearTimeout(t)
  }, [doneMark])

  const closable = open && auto && !engaged && canAutoClose(items, nodeId, session.current)
  useEffect(() => {
    if (!closable) return
    const t = setTimeout(() => cb.current.onAutoClose(), AUTO_CLOSE_MS)
    return () => clearTimeout(t)
  }, [closable])

  return { auto, setEngaged, doneMark }
}
