// First-run wizard "Set up webterm": a modal with the step list on the left and one step on the
// right. Visible while the URL has `?setup=` (`setup.open.ts`); Escape / the close button clear it,
// progress stays (each step is PATCHed into `settings.setup` the moment it is answered). Finish
// sets `completedAt` and shows the Done panel with the project actions.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import type { Settings } from '../../shared/settings'
import type { SettingsPatch } from '../../shared/settings.patch'
import { SETUP_STEPS, type SetupStep, type SetupStepState } from '../../shared/settings.setup'
import { listCommands } from '../commandRegistry'
import { resumeStep, useSetupRoute } from './setup.open'
import { SETUP_TEXT } from './setup.labels'
import { SetupStepBody } from './setup.steps'
import type { StepNav } from './setup.ui'

export interface SetupDialogProps {
  /** Live settings (App's `useSettings`), for the saved progress and the Basics step. */
  settings: Settings
  /** Settings PATCH (App's `useSettings().update`). */
  update(patch: SettingsPatch): void
}

const MARK: Record<SetupStepState | 'current' | 'todo', string> = { done: '✓', skipped: '–', current: '●', todo: '○' }

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
    <div className="flex flex-col gap-3" data-setup-done>
      <p className="m-0 text-sm font-semibold">{SETUP_TEXT.doneTitle}</p>
      <p className="m-0 text-xs opacity-80">{SETUP_TEXT.doneBody}</p>
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
  const close = (): void => { setDone(false); route.close() }

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
      <DialogContent className="sm:max-w-[760px]" data-setup-dialog>
        <div className="flex min-h-[420px] gap-4 max-sm:flex-col">
          <nav aria-label={SETUP_TEXT.title} className="flex w-40 shrink-0 flex-col gap-1 max-sm:w-full">
            <DialogTitle className="text-sm">{SETUP_TEXT.title}</DialogTitle>
            <DialogDescription className="text-xs">{done ? SETUP_TEXT.doneTitle : SETUP_TEXT.stepOf(index + 1, SETUP_STEPS.length)}</DialogDescription>
            <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
              {SETUP_STEPS.map((s) => {
                const kind = !done && s === current ? 'current' : settings.setup.steps[s] ?? 'todo'
                return (
                  <li key={s} data-step={s} data-state={kind}>
                    <Button size="sm" variant="ghost" className="w-full justify-start" aria-current={kind === 'current' ? 'step' : undefined}
                      onClick={() => { setDone(false); route.open(s) }}>
                      <span aria-hidden="true" className="w-4">{MARK[kind]}</span>
                      {SETUP_TEXT.steps[s]}
                      <span className="sr-only"> ({SETUP_TEXT.state[kind]})</span>
                    </Button>
                  </li>
                )
              })}
            </ol>
          </nav>
          <section aria-label={done ? SETUP_TEXT.doneTitle : SETUP_TEXT.steps[current]} className="flex min-w-0 flex-1 flex-col overflow-y-auto">
            {done ? <DonePanel close={close} /> : (
              <>
                <h3 data-setup-heading className="m-0 mb-2 text-sm font-semibold">{SETUP_TEXT.steps[current]}</h3>
                {/* key: a new step starts with fresh local state (choices, errors). */}
                <SetupStepBody key={current} step={current} nav={nav} settings={settings} update={update} />
              </>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
