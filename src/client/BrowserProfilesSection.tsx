// Settings › Browser: the list of browser profiles. A profile is its own login session; browsers on different profiles
// never share cookies. States: browser off, loading, failed (Retry), empty, list. "New profile" asks only for a name.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import BrowserProfileCreateDialog from './BrowserProfileCreateDialog'
import BrowserProfileRow from './BrowserProfileRow'
import { useBrowserStatus } from './browser.feature'
import { useProfileList } from './browserProfile.list'
import { PROFILE_TEXT as T } from './browserProfile.text'
import { CardEmpty, CardError, CardLoading } from './SettingsCardState'
import { SettingsGroup } from './SettingsControls'

/** Settings page body; `workspaceId` scopes the list to the open board's profiles ('' = all). */
export function BrowserProfilesSection({ workspaceId = '' }: { workspaceId?: string }): React.JSX.Element {
  const status = useBrowserStatus()
  const { profiles, error, reload } = useProfileList(workspaceId || undefined)
  const [creating, setCreating] = useState(false)
  const [loaded, setLoaded] = useState(false)
  if (profiles.length > 0 && !loaded) setLoaded(true)

  let body: React.JSX.Element
  if (!status) body = <CardEmpty text={`${T.off}. ${T.offHint}`} />
  else if (error && profiles.length === 0) body = <CardError text={T.listFailed} onRetry={reload} />
  else if (profiles.length === 0) body = !loaded && !error ? <CardLoading text={T.loading} /> : <CardEmpty text={T.noProfiles} />
  else body = <ul role="list" aria-label={T.groupTitle} className="m-0 flex list-none flex-col divide-y p-0">{profiles.map((p) => <BrowserProfileRow key={p.id} profile={p} onChanged={reload} />)}</ul>

  return (
    <div className="flex flex-col" data-testid="browser-profiles-section" data-field="browser-profiles">
      <SettingsGroup title={T.groupTitle} description={`${T.sectionHint} ${T.sharedSession}`}>
        {body}
        {status && <div className="flex justify-end p-2"><Button size="sm" onClick={() => setCreating(true)}>{T.newProfile}</Button></div>}
      </SettingsGroup>
      {creating && <BrowserProfileCreateDialog onClose={() => setCreating(false)} onCreated={() => { setCreating(false); reload() }} />}
    </div>
  )
}
