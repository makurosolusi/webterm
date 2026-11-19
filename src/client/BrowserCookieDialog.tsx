// Cookie import for the browser of one workspace (opened from the toolbar's ⋮ menu). The dialog itself lives in
// `browserCookies/`; this wrapper only picks the target and mounts it while open (so every open starts clean).
import { useMemo } from 'react'
import CookieImportDialog from './browserCookies/CookieImportDialog'
import { workspaceTarget } from './browserCookies/cookieImport.target'

export interface BrowserCookieDialogProps {
  /** From `BrowserStatusResp.cookieImportEnabled`; false = nothing is rendered. */
  cookieImportEnabled: boolean
  workspaceId: string
  open: boolean
  onClose: () => void
}

const TARGET_NAME = 'this browser'

export default function BrowserCookieDialog({ cookieImportEnabled, workspaceId, open, onClose }: BrowserCookieDialogProps): React.JSX.Element | null {
  const target = useMemo(() => workspaceTarget(workspaceId, TARGET_NAME), [workspaceId])
  return cookieImportEnabled && open ? <CookieImportDialog target={target} onClose={onClose} /> : null
}
