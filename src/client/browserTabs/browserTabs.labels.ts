// Display text for a tab: title fallback, host, status words and the accessible name. Pure, so the strip,
// the All-tabs menu and tests agree on one wording.
import { BLANK_URL, type BrowserTab } from '../../shared/browser.tabs'

/** Hostname of an http(s) URL; '' for blank or unparsable URLs. */
export function hostOf(url: string): string {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.host : ''
  } catch {
    return '' // about:blank and half-typed URLs have no host
  }
}

export const isBlankTab = (t: BrowserTab): boolean => t.url === '' || t.url === BLANK_URL

/** Title shown in the strip: the page title, else the host, else "New tab". */
export function tabTitle(t: BrowserTab): string {
  return t.title.trim() || (isBlankTab(t) ? 'New tab' : hostOf(t.url) || t.url)
}

/** Status words in reading order, e.g. ['loading', 'agent working here']. */
export function tabStatus(t: BrowserTab, isAgent: boolean): string[] {
  const out: string[] = []
  if (t.crashed) out.push('crashed')
  else if (t.discarded) out.push('sleeping, reloads when opened')
  else if (t.loading) out.push('loading')
  if (isAgent) out.push('agent working here')
  return out
}

/** Accessible name: "Title, loading, agent working here". */
export function tabAriaLabel(t: BrowserTab, isAgent: boolean): string {
  return [tabTitle(t), ...tabStatus(t, isAgent)].join(', ')
}

/** Tooltip: full title, then the host when it adds information. */
export function tabTooltip(t: BrowserTab): string {
  const title = tabTitle(t)
  const host = hostOf(t.url)
  return host && host !== title ? `${title} - ${host}` : title
}
