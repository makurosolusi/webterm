// Notice for a link a terminal opened that webterm caught and showed in a canvas browser node (`t:'linkOpened'`).
// The server sends the hostname only (a sign-in URL can carry a token); the browser node itself is revealed by the `view` frame.
import { useEffect } from 'react'
import type { LinkOpenedMsg } from '../shared/protocol'
import { subscribeLinkOpened } from './ws'
import { closeNotice, showNotice } from './workspaceSave.notice'

export const LINK_NOTICE_KEY = 'webterm-link-opened'
/** How long the notice stays; it is information, not something to act on. */
export const LINK_NOTICE_MS = 8000

/** Words of the notice. */
export const linkOpenedTitle = (msg: Pick<LinkOpenedMsg, 'host' | 'created'>): string =>
  `Link opened in canvas browser: ${msg.host}${msg.created ? ' (new browser node added next to the terminal)' : ''}`

/** Show the notice for as long as the caller is mounted and a link is captured. */
export function useLinkOpenedNotice(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = subscribeLinkOpened((msg) => {
      showNotice(LINK_NOTICE_KEY, { title: linkOpenedTitle(msg), severity: 'info' })
      clearTimeout(timer)
      timer = setTimeout(() => closeNotice(LINK_NOTICE_KEY), LINK_NOTICE_MS)
    })
    return () => { off(); clearTimeout(timer) }
  }, [])
}
