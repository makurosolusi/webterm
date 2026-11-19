// Cookies of ONE browser profile (Settings > Browser > profile menu > Import cookies…). The dialog itself lives in
// `browserCookies/`; this wrapper only names the profile as the target.
import { useMemo } from 'react'
import type { BrowserProfile } from '../shared/browser.profile'
import CookieImportDialog from './browserCookies/CookieImportDialog'
import { profileTarget } from './browserCookies/cookieImport.target'

export default function BrowserProfileCookieDialog({ profile, onClose, onChanged }: { profile: BrowserProfile; onClose: () => void; onChanged: () => void }): React.JSX.Element {
  const target = useMemo(() => profileTarget(profile.id, profile.name), [profile.id, profile.name])
  return <CookieImportDialog target={target} onClose={onClose} onChanged={onChanged} />
}
