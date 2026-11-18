// Leading icon of a tab: crashed > loading spinner (replaces the favicon) > discarded (dimmed) > favicon > globe.
import { useState } from 'react'
import { Globe, LoaderCircle, Moon, TriangleAlert } from 'lucide-react'
import type { BrowserTab } from '../../shared/browser.tabs'

/** Decorative: the tab's accessible name already carries the status. */
export function BrowserTabIcon({ tab }: { tab: BrowserTab }) {
  const [failed, setFailed] = useState<string | null>(null)
  if (tab.crashed) return <TriangleAlert className="bt-icon bt-icon--crashed" data-icon="crashed" aria-hidden="true" />
  if (tab.loading) return <LoaderCircle className="bt-icon bt-spinner" data-icon="loading" aria-hidden="true" />
  if (tab.discarded) return <Moon className="bt-icon bt-icon--dim" data-icon="discarded" aria-hidden="true" />
  if (tab.favicon && failed !== tab.favicon) {
    return <img className="bt-icon bt-favicon" data-icon="favicon" src={tab.favicon} alt="" draggable={false} referrerPolicy="no-referrer" onError={() => setFailed(tab.favicon ?? null)} />
  }
  return <Globe className="bt-icon" data-icon="globe" aria-hidden="true" />
}
