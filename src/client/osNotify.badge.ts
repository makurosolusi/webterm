// Unread count on the browser tab: `document.title` "(n) webterm" and a favicon with a count
// badge — the browser stand-ins for Orca's Dock badge / tray attention
// (orca-src src/main/notifications/notification-delivery-service.ts:70-75). Driven by `./unread`
// on every change, so the count is always the unread set's size.

const BASE_TITLE = 'webterm'
/** The static icon `index.html` links: the normal, badge-free state. */
export const FAVICON_PATH = '/favicon.svg'

/** The tab icon as SVG; `count` > 0 adds the red unread badge. `public/favicon.svg` is `faviconSvg(0)` (locked by test). */
export function faviconSvg(count: number): string {
  // SVG, not <canvas>: no raster context needed (works in jsdom too) and it stays crisp at any DPI.
  const label = count > 99 ? '99+' : String(count)
  const badge = count > 0
    ? `<circle cx="23" cy="9" r="9" fill="#e5484d"/><text x="23" y="13" font-size="${label.length > 1 ? 9 : 12}" font-family="sans-serif" font-weight="700" text-anchor="middle" fill="#fff">${label}</text>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="1" y="3" width="28" height="26" rx="5" fill="#1e1e1e"/><path d="M7 12l5 4-5 4" stroke="#4fc1ff" stroke-width="2.5" fill="none" stroke-linecap="round"/><path d="M14 21h8" stroke="#ccc" stroke-width="2.5" stroke-linecap="round"/>${badge}</svg>`
}

/** Show `count` unread on the tab title and icon; 0 restores the static `/favicon.svg`. */
export function setBadgeCount(count: number): void {
  if (typeof window === 'undefined') return // no tab to badge (node-env tests)
  document.title = count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE
  // index.html ships the one icon link; it is created only on a page without one, so never a second link.
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    link.type = 'image/svg+xml'
    document.head.appendChild(link)
  }
  link.href = count > 0 ? `data:image/svg+xml,${encodeURIComponent(faviconSvg(count))}` : FAVICON_PATH
}
