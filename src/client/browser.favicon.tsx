// Site icon for start-page tiles and recent rows. The node renders pages server-side and has no favicon feed, so
// the icon is the site's own `/favicon.ico` (the convention every browser falls back to) — no third-party favicon
// service. The letter circle shows while the image loads and stays when it fails.
import { useState } from 'react'

/** `<origin>/favicon.ico` of an http(s) URL, or null when it does not parse. */
export function faviconUrl(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? `${u.origin}/favicon.ico` : null
  } catch {
    return null // not a URL: the letter circle is the whole icon
  }
}

/** Decorative icon (the row/tile carries the accessible name). */
export default function BrowserFavicon({ url, label, color, className }: { url: string; label: string; color?: string; className: string }) {
  const src = faviconUrl(url)
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading')
  const [forSrc, setForSrc] = useState(src)
  if (forSrc !== src) { setForSrc(src); setState('loading') } // edited shortcut: try the new site's icon
  return (
    <span className={className} data-favicon={state} aria-hidden="true">
      {state !== 'ok' && <span className="browser-favicon__letter" style={color ? { background: color } : undefined}>{(label.trim()[0] ?? '?').toUpperCase()}</span>}
      {src && state !== 'error' && (
        <img className="browser-favicon__img" src={src} alt="" referrerPolicy="no-referrer" loading="lazy" draggable={false}
          onLoad={() => setState('ok')} onError={() => setState('error')} />
      )}
    </span>
  )
}
