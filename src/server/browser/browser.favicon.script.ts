// Page-side script of the favicon reader (run through Runtime.evaluate). It installs, once per document, a quiet
// MutationObserver on <head> that calls the `webtermFavicon` binding when a <link> is added or its href/rel changes, then
// returns the icon declarations as JSON. Anything that goes wrong in the page yields an empty list (the origin fallback).
import { MAX_ICON_LINKS } from '../../shared/browser.favicon'

/** Name of the CDP binding the page calls when its icon links change. */
export const FAVICON_BINDING = 'webtermFavicon'

export const READ_ICON_LINKS = `(() => {
  try {
    if (!window.__webtermFavObserver && document.head && typeof ${FAVICON_BINDING} === 'function') {
      Object.defineProperty(window, '__webtermFavObserver', { value: true })
      new MutationObserver(() => ${FAVICON_BINDING}('')).observe(document.head, { subtree: true, childList: true, attributes: true, attributeFilter: ['href', 'rel'] })
    }
    return JSON.stringify(Array.from(document.querySelectorAll('link[rel]'))
      .filter((l) => /icon/i.test(l.rel))
      .slice(0, ${MAX_ICON_LINKS})
      .map((l) => ({ rel: l.rel, href: l.href, sizes: l.getAttribute('sizes') || undefined, type: l.type || undefined, media: l.media || undefined })))
  } catch (e) {
    return '[]'
  }
})()`
