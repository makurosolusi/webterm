// The dialog behind "Browser with profile…" (pick one: a click opens it) and "Open a browser for each profile…"
// (tick several, then "Open N browsers"). The main case: five accounts, five clicks of one dialog, five browsers in
// a grid, each already signed in. Opening respects the active-browser limit: what fits opens, the rest is reported.
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { BrowserProfile } from '../shared/browser.profile'
import BrowserProfileCreateDialog from './BrowserProfileCreateDialog'
import { getBrowserStatus } from './browser.api'
import { ProfileDot, useProfileList } from './browserProfile.list'
import { closeProfileSpawn, useProfileSpawn } from './browserProfile.spawn'
import type { ProfileSpawner, SpawnRequest } from './browserProfile.spawn'
import { PROFILE_TEXT as T } from './browserProfile.text'
import { useActiveWorkspaceId } from './activeWorkspace.context'
import { showLimitNotice } from './browserLimit.notice'

const NOTICE_KEY = 'webterm-browser-profile-spawn'

/** Free slots for new live browsers, or Infinity when the server cannot say (it still enforces the limit). */
const freeSlots = (): Promise<{ free: number; max: number }> =>
  getBrowserStatus().then((s) => ({ free: Math.max(0, s.maxLive - s.live), max: s.maxLive }), () => ({ free: Infinity, max: 0 }))

function Row({ p }: { p: BrowserProfile }): React.JSX.Element {
  return (
    <>
      <ProfileDot profile={p} />
      <span className="flex-1 truncate">{p.name}</span>
      <span className="text-xs text-(--vscode-descriptionForeground)">{T.rowHint(p)}</span>
    </>
  )
}

function SpawnBody({ request, spawner }: { request: SpawnRequest; spawner: ProfileSpawner }): React.JSX.Element {
  const workspaceId = useActiveWorkspaceId() ?? ''
  const { profiles, error, reload } = useProfileList(workspaceId || undefined)
  const each = request.mode === 'each'
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null)
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  // "each" starts with every profile ticked; the user's own ticks win once they touch a box.
  const ticked = useMemo(() => picked ?? new Set(profiles.map((p) => p.id)), [picked, profiles])
  const chosen = profiles.filter((p) => ticked.has(p.id))
  useEffect(() => { setPicked(null) }, [request])

  const toggle = (id: string, on: boolean): void => setPicked((prev) => { const n = new Set(prev ?? ticked); if (on) n.add(id); else n.delete(id); return n })

  // Opens what fits; the rest is reported with "Raise limit" / "Settings", and "Try again" opens only the ones still missing.
  const openList = (list: readonly BrowserProfile[], total: number, already: number): Promise<void> =>
    freeSlots().then(({ free, max }) => {
      const opened = spawner.openMany(list, free)
      if (opened < list.length) {
        const title = already + opened === 0 ? T.openedNone(max) : T.openedSome(already + opened, total, max)
        void showLimitNotice(NOTICE_KEY, 'warning', title, { max, retry: () => { void openList(list.slice(opened), total, already + opened) } })
      }
    })
  const openEach = (): void => {
    setBusy(true)
    openList(chosen, chosen.length, 0).then(closeProfileSpawn).finally(() => setBusy(false))
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{each ? T.eachTitle : T.pickTitle}</DialogTitle>
        <DialogDescription>{each ? T.eachHint : T.pickHint}</DialogDescription>
      </DialogHeader>
      {error && (
        <p role="alert" className="m-0 flex items-center gap-2 text-xs text-(--vscode-errorForeground)">
          {T.listFailed}<Button size="bui" variant="outline" onClick={reload}>{T.retry}</Button>
        </p>
      )}
      {!error && profiles.length === 0 && <p role="status" className="m-0 text-sm">{T.noProfiles}</p>}
      {each ? (
        <fieldset className="m-0 flex max-h-72 flex-col gap-1 overflow-auto border-0 p-0">
          <legend className="sr-only">{T.eachTitle}</legend>
          {profiles.length > 1 && (
            <label className="flex items-center gap-2 py-1 text-sm font-medium">
              <Checkbox checked={chosen.length === profiles.length ? true : chosen.length === 0 ? false : 'indeterminate'}
                onCheckedChange={(v) => setPicked(new Set(v === true ? profiles.map((p) => p.id) : []))} />
              {T.selectAll}
            </label>
          )}
          {profiles.map((p) => (
            <label key={p.id} className="flex items-center gap-2 py-1 text-sm">
              <Checkbox checked={ticked.has(p.id)} onCheckedChange={(v) => toggle(p.id, v === true)} aria-label={p.name} />
              <Row p={p} />
            </label>
          ))}
        </fieldset>
      ) : (
        <ul role="list" aria-label={T.pickTitle} className="m-0 flex max-h-72 list-none flex-col gap-1 overflow-auto p-0">
          {profiles.map((p) => (
            <li key={p.id}>
              <Button variant="ghost" className="w-full justify-start gap-2 font-normal" onClick={() => { spawner.openOne(p, request.at); closeProfileSpawn() }}>
                <Row p={p} />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <DialogFooter className="sm:justify-between">
        <Button type="button" variant="ghost" onClick={() => setCreating(true)}>{T.newProfile}</Button>
        <span className="flex gap-2">
          <Button type="button" variant="secondary" onClick={closeProfileSpawn}>{T.cancel}</Button>
          {each && <Button type="button" disabled={chosen.length === 0 || busy} aria-busy={busy} onClick={openEach}>{busy ? T.opening : T.openN(chosen.length)}</Button>}
        </span>
      </DialogFooter>
      {creating && <BrowserProfileCreateDialog onClose={() => setCreating(false)} onCreated={(p) => { setCreating(false); reload(); setPicked((prev) => new Set([...(prev ?? ticked), p.id])) }} />}
    </>
  )
}

/** Always mounted once (AppHosts); shows the dialog while a request is open. */
export default function BrowserProfileSpawnDialog(): React.JSX.Element | null {
  const { request, spawner } = useProfileSpawn()
  if (!request || !spawner) return null
  return (
    <Dialog open onOpenChange={(o) => { if (!o) closeProfileSpawn() }}>
      <DialogContent showCloseButton={false}><SpawnBody request={request} spawner={spawner} /></DialogContent>
    </Dialog>
  )
}
