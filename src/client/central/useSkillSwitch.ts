// The inline on/off switch of one skill row (optimistic, rolled back on failure), shared by the Control library and the canvas Skills panel.
import { useEffect, useState } from 'react'
import { CL } from './centralLabels'
import type { CentralControlClient, SkillReviewRow } from './centralControlTypes'
import { centralErrorMessage } from './centralLoad'

export function useSkillSwitch(row: SkillReviewRow, client: CentralControlClient, onChanged: () => void) {
  const { name } = row.record
  const serverOn = row.record.enabled !== false
  const [on, setOn] = useState(serverOn)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setOn(serverOn), [serverOn])
  const flip = (next: boolean): void => {
    setOn(next)
    setBusy(true)
    setError(null)
    client.setSkillEnabled(name, next).then(
      () => { setBusy(false); onChanged() },
      (err: unknown) => { setOn(!next); setBusy(false); setError(centralErrorMessage(err, CL.skillEnabledFailed)) },
    )
  }
  return { on, busy, error, flip }
}
