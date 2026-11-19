// The canvas browser's own context menu, client half: the server answers a right click with what is under the pointer
// (`contextMenu` message); this draws the shared VscodeMenu at the pointer. Right clicks on the tab strip and toolbar are
// not the page's and keep their own menus (the pointer is only tracked inside the node's page body).
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { VscodeMenu } from '@/components/vscode/vscodeMenu'
import type { ClientMsg, ServerMsg } from '../../shared/browser.contract'
import type { ContextInfo } from '../../shared/browser.contextmenu'
import { writeClipboard } from '../browser.clipboard'
import { chunkText } from '../browser.input'
import { contextMenuItems } from './browserContextMenu.items'

export type ContextMenuMsg = Extract<ServerMsg, { t: 'contextMenu' }>
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never

interface Open { info: ContextInfo; tab?: string; at: { x: number; y: number } }

export interface ContextMenuHookDeps {
  /** The node's page body: right presses inside it place the menu. */
  bodyRef: RefObject<HTMLElement | null>
  send: (m: WithoutId<ClientMsg>) => void
  nav: (action: 'back' | 'forward' | 'reload') => void
  canBack: boolean
  canForward: boolean
  notify: (text: string, severity?: 'info' | 'warning' | 'error') => void
}

/** `onMsg` returns true when it consumed the message; `menu` is the element to render (null while closed). */
export function useBrowserContextMenu(d: ContextMenuHookDeps): { onMsg: (m: { t: string }) => boolean; menu: ReactNode } {
  const [open, setOpen] = useState<Open | null>(null)
  const pointer = useRef({ x: 0, y: 0 })
  const { bodyRef } = d

  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const note = (e: MouseEvent) => { if (e.button === 2 || e.type === 'contextmenu') pointer.current = { x: e.clientX, y: e.clientY } }
    el.addEventListener('pointerdown', note, true)
    el.addEventListener('contextmenu', note, true)
    return () => { el.removeEventListener('pointerdown', note, true); el.removeEventListener('contextmenu', note, true) }
  }, [bodyRef])

  const onMsg = useCallback((m: { t: string }): boolean => {
    if (m.t !== 'contextMenu') return false
    const { tab, link, image, selection, editable } = m as ContextMenuMsg
    setOpen({ info: { ...(link ? { link } : {}), ...(image ? { image } : {}), selection, editable }, tab, at: pointer.current })
    return true
  }, [])

  const { send, notify } = d
  const close = useCallback(() => setOpen(null), [])
  const copyText = useCallback((text: string) => { void writeClipboard(text).then((r) => { if (!r.ok) notify(r.error, 'warning') }) }, [notify])
  const paste = useCallback(() => {
    if (!navigator.clipboard?.readText) { notify('Paste needs a secure context (the clipboard is not readable here)', 'warning'); return }
    navigator.clipboard.readText().then((text) => { for (const part of chunkText(text)) send({ t: 'text', text: part }) }, (err: unknown) => notify(`Paste failed: ${err instanceof Error ? err.message : 'clipboard not readable'}`, 'warning'))
  }, [send, notify])
  // Cut = copy the selection, then delete it with the real key (the page's own editing handles the rest).
  const cut = useCallback(() => {
    send({ t: 'copy' })
    send({ t: 'key', type: 'down', key: 'Backspace', code: 'Backspace', text: '', vk: 8, mods: 0 })
    send({ t: 'key', type: 'up', key: 'Backspace', code: 'Backspace', text: '', vk: 8, mods: 0 })
  }, [send])

  const menu = open
    ? <VscodeMenu
        open anchor={open.at} onClose={close} ariaLabel="Page actions"
        items={contextMenuItems(open.info, {
          canBack: d.canBack, canForward: d.canForward, nav: d.nav, copyText, paste, cut,
          openLink: (url) => send({ t: 'openLink', url, ...(open.tab ? { tab: open.tab } : {}) }),
          copySelection: () => send({ t: 'copy' }),
        })}
      />
    : null
  return { onMsg, menu }
}
