// Leading icon of a tab: crashed > loading spinner (replaces the favicon) > discarded (the last favicon dimmed, else a moon) > favicon > globe.
import { useState } from 'react'
import { Globe, LoaderCircle, Moon, TriangleAlert } from 'lucide-react'
import type { BrowserTab } from '../../shared/browser.tabs'

/** The page's own icon is only ever the server's data URI (sniffed and sanitised there); a remote URL is never loaded by the client. */
const SAFE_ICON = /^data:image\/(?:png|x-icon|jpeg|gif|webp|svg\+xml);base64,/

/** Decorative: the tab's accessible name already carries the status. */
export function BrowserTabIcon({ tab }: { tab: BrowserTab }) {
  const [failed, setFailed] = useState<string | null>(null)
  const icon = tab.faviconData && SAFE_ICON.test(tab.faviconData) && failed !== tab.faviconData ? tab.faviconData : undefined
  if (tab.crashed) return <TriangleAlert className="bt-icon bt-icon--crashed" data-icon="crashed" aria-hidden="true" />
  if (tab.loading) return <LoaderCircle className="bt-icon bt-spinner" data-icon="loading" aria-hidden="true" />
  if (icon) {
    return (
      <img
        className={tab.discarded ? 'bt-icon bt-favicon bt-icon--dim' : 'bt-icon bt-favicon'} data-icon={tab.discarded ? 'discarded' : 'favicon'}
        src={icon} alt="" draggable={false} referrerPolicy="no-referrer" onError={() => setFailed(icon)}
      />
    )
  }
  if (tab.discarded) return <Moon className="bt-icon bt-icon--dim" data-icon="discarded" aria-hidden="true" />
  return <Globe className="bt-icon" data-icon="globe" aria-hidden="true" />
}
