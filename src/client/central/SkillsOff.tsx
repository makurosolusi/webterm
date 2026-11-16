// Skills switched off: what they do and the Central card's skills switch (applies live, no restart).
import { ActionButton, ActionResult, useAction } from '@/components/ui/action'
import { useCapabilities } from '../useCapabilities'
import { CL } from './centralLabels'
import { CENTRAL_SKILLS_SUB } from './centralControlApi'

export default function SkillsOff({ onEnabled }: { onEnabled: () => void }) {
  const { busyId, error, setSub } = useCapabilities()
  // setSub answers false and fills the hook's `error` (the reason, shown under the failure line).
  const enable = useAction(async () => { const ok = await setSub('central', CENTRAL_SKILLS_SUB, true); if (ok) onEnabled(); return ok }, {
    label: CL.turnOn, ok: (ok) => ok, success: (ok) => (ok ? CL.actionDone : `${CL.turnOn} failed`),
  })
  return (
    <div className="ccp-off" data-central-off="skills">
      <p>{CL.skillsOff}</p>
      <ActionButton type="button" size="sm" disabled={busyId === 'central'} action={enable} busyLabel="Turning on…">{CL.turnOn}</ActionButton>
      <ActionResult action={enable}>{error && <p className="ccp-error">{error}</p>}</ActionResult>
    </div>
  )
}
