// What the browser node header says: ONE title and ONE host, never the same URL twice. Pure, so tests pin the rules.
import { hostOf } from './browserTabs/browserTabs.labels'

export interface HeaderLabels {
  title: string
  /** Muted text after the title; '' when the title already carries the host. */
  description: string
  /** Full URL for the tooltip (the omnibox holds the editable copy). */
  hint?: string
}

const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i

/**
 * The page title is often the URL itself until the page sets one. A URL is not a title: show the host instead, and drop the
 * description so "www.google.com" does not appear twice. A user-chosen node title always wins.
 */
export function browserHeaderLabels(o: { userTitle?: string; pageTitle?: string; url?: string; fallback: string }): HeaderLabels {
  const host = o.url ? hostOf(o.url) : ''
  const hint = o.url && host ? o.url : undefined
  const page = o.pageTitle?.trim() ?? ''
  if (o.userTitle) return { title: o.userTitle, description: host, hint }
  if (!page || URL_LIKE.test(page)) return { title: host || o.fallback, description: '', hint }
  return { title: page, description: host && !page.includes(host) ? host : '', hint }
}
