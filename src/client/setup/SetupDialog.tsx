// First-run wizard "Set up webterm": a fixed-size modal with a header (title, "Step n of 4", Close), the
// stepper on the left and one step on the right (its body scrolls, its footer stays). Visible while the
// URL has `?setup=` (`setup.open.ts`); Escape / Close clear it, progress stays (each step is PATCHed
// into `settings.setup` the moment it is answered). Finish sets `completedAt` and shows the Done panel.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { IconButton } from '@/components/ui/icon-button'
import type { Settings } from '../../shared/settings'
import type { SettingsPatch } from '../../shared/settings.patch'
import { SETUP_STEPS, type SetupStep, type SetupStepState } from '../../shared/settings.setup'
import { listCommands } from '../commandRegistry'
import { reloadSettings } from '../useSettings'
import { resumeStep, useSetupRoute } from './setup.open'
import { SETUP_TEXT } from './setup.labels'
import { SetupStepper } from './setup.stepper'
import { SetupStepBody } from './setup.steps'
import { StepHeading, type StepNav } from './setup.ui'

export interface SetupDialogProps {
  /** Live settings (App's `useSettings`), for the saved progress and the Basics step. */
  settings: Settings
  /** Settings PATCH (App's `useSettings().update`). */
  update(patch: SettingsPatch): void
}

/** Commands the Done panel offers, by registry id (`WorkspaceCreateHost`); missing ones are hidden. */
const DONE_ACTIONS = [
  { id: 'workspace.newProject', label: SETUP_TEXT.doneActions.newProject },
  { id: 'workspace.openFolder', label: SETUP_TEXT.doneActions.openFolder },
  { id: 'workspace.clone', label: SETUP_TEXT.doneActions.clone },
] as const

function DonePanel({ close }: { close(): void }): React.JSX.Element {
  const commands = listCommands()
  const run = (id: string): void => {
    close()
    commands.find((c) => c.id === id)?.run?.()
  }
  return (
    <div className="flex flex-col gap-3 px-5 py-4" data-setup-done>
      <StepHeading>{SETUP_TEXT.doneTitle}</StepHeading>
      <p className="m-0 text-xs text-(--vscode-descriptionForeground)">{SETUP_TEXT.doneBody}</p>
      <div className="flex flex-wrap gap-2">
        {DONE_ACTIONS.filter((a) => commands.some((c) => c.id === a.id)).map((a, i) => (
          <Button key={a.id} size="sm" variant={i === 0 ? 'default' : 'outline'} onClick={() => run(a.id)}>{a.label}</Button>
        ))}
        <Button size="sm" variant="ghost" onClick={close}>{SETUP_TEXT.close}</Button>
      </div>
    </div>
  )
}

/** The wizard; renders nothing while `?setup=` is absent. Mount once inside the router. */
export default function SetupDialog({ settings, update }: SetupDialogProps): React.JSX.Element | null {
  const route = useSetupRoute()
  const [done, setDone] = useState(false)
  if (route.step === null) return null
  const current: SetupStep = route.step === 'resume' ? resumeStep(settings.setup) : route.step
  const index = SETUP_STEPS.indexOf(current)
  // The steps write some settings straight to the server (the provider card's launch profile): re-read them on close.
  const close = (): void => { setDone(false); route.close(); void reloadSettings() }

  const answer = (state: SetupStepState): void => {
    const last = index === SETUP_STEPS.length - 1
    update({ setup: { steps: { [current]: state }, ...(last ? { completedAt: Date.now() } : {}) } })
    if (last) setDone(true)
    else route.open(SETUP_STEPS[index + 1])
  }
  const nav: StepNav = {
    index,
    total: SETUP_STEPS.length,
    back: () => route.open(SETUP_STEPS[Math.max(index - 1, 0)]),
    skip: () => answer('skipped'),
    next: () => answer('done'),
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) close() }}>
      {/* Initial focus: the step heading takes it (StepHeading), not the first button in the header. */}
      <DialogContent showCloseButton={false} onOpenAutoFocus={(e) => e.preventDefault()} data-setup-dialog
        className="flex h-[min(640px,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[860px]">
        <DialogHeader className="flex-row items-center gap-3 border-b border-(--vscode-widget-border,var(--vscode-panel-border)) px-5 py-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <DialogTitle>{SETUP_TEXT.title}</DialogTitle>
            <DialogDescription className="text-xs">{done ? SETUP_TEXT.complete : SETUP_TEXT.stepOf(index + 1, SETUP_STEPS.length)}</DialogDescription>
          </div>
          <IconButton label={SETUP_TEXT.close} onClick={close}><span className="codicon codicon-close" aria-hidden="true" /></IconButton>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 max-sm:flex-col">
          <SetupStepper current={done ? null : current} answers={settings.setup.steps} go={(s) => { setDone(false); route.open(s) }} />
          <section aria-label={done ? SETUP_TEXT.doneTitle : SETUP_TEXT.steps[current]} className="flex min-h-0 min-w-0 flex-1 flex-col">
            {/* key: a new step starts with fresh local state (choices, errors). */}
            {done ? <DonePanel close={close} /> : <SetupStepBody key={current} step={current} nav={nav} settings={settings} update={update} />}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
