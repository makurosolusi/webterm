// "Terminal" box of the custom-commands panel (setup wizard + Settings): a real shell, closed by default,
// for installing tools and signing in without a shell on the machine. It reuses TerminalCore and the normal
// PTY session (id SETUP_TERMINAL_ID, in the user's home), which no board node owns. Quick commands are only
// TYPED into it (no Enter): the user sees every command before it runs. After output goes quiet, the tool list
// is rescanned so a fresh install shows up in "Found" without a click.
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { CustomCommandDetected } from '../../shared/customCommands'
import { SETUP_TERMINAL_ID } from '../../shared/setupTerminal'
import { send } from '../ws'
import { LEAVE_CHORD_LABEL } from '../terminalKeys'
import type { TerminalHandle } from '../TerminalCore'
import { COMMANDS_TEXT } from './commands.labels'
import { COMMAND_RECIPES, visibleRecipes } from './commands.recipes'

const T = COMMANDS_TEXT.terminal
const TerminalCore = lazy(() => import('../TerminalCore')) // keeps xterm out of the wizard until someone opens the terminal
/** Quiet time after the last output before the tool list is rescanned, and the least gap between two rescans. */
export const RESCAN_IDLE_MS = 2000
export const RESCAN_MIN_GAP_MS = 5000
/** The setup terminal is a fixed-height box (the page scrolls, not the box). */
const BOX = 'h-[260px] min-h-[200px] overflow-hidden rounded-md border border-(--vscode-widget-border,var(--vscode-panel-border))'

type Phase = 'opening' | 'connected' | 'ended' | 'failed'

export function CommandsTerminal({ detected, onActivity }: { detected: readonly CustomCommandDetected[]; onActivity(): Promise<void> }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<Phase>('opening')
  const [attempt, setAttempt] = useState(0) // a new key remounts TerminalCore = a fresh `open` on retry
  const handle = useRef<TerminalHandle>(null)
  const closeBtn = useRef<HTMLButtonElement>(null)
  const armed = useRef(false) // a quick command was used: rescan on idle from now until the terminal closes
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const lastScan = useRef(0)
  const live = useRef(onActivity)
  live.current = onActivity

  const endSession = useCallback((): void => {
    clearTimeout(timer.current)
    armed.current = false
    send({ t: 'close', id: SETUP_TERMINAL_ID })
  }, [])
  // Leaving the step (unmount) must not leave a shell behind.
  const isOpen = useRef(false)
  isOpen.current = open
  useEffect(() => () => { if (isOpen.current) endSession() }, [endSession])

  const onOutput = useCallback((): void => {
    setPhase((p) => (p === 'opening' ? 'connected' : p))
    if (!armed.current) return
    clearTimeout(timer.current)
    const wait = Math.max(RESCAN_IDLE_MS, lastScan.current + RESCAN_MIN_GAP_MS - Date.now())
    timer.current = setTimeout(() => {
      lastScan.current = Date.now()
      live.current().catch((e: unknown) => console.warn('setup terminal: tool rescan failed', e instanceof Error ? e.message : e))
    }, wait)
  }, [])

  const found = new Set(detected.filter((d) => d.found).map((d) => d.name))
  const recipes = visibleRecipes(found, COMMAND_RECIPES)
  const close = (): void => { endSession(); setOpen(false) }
  const start = (): void => { setPhase('opening'); setAttempt((n) => n + 1); setOpen(true) }

  return (
    <section className="flex flex-col gap-2" aria-label={T.title} data-commands-terminal>
      <div className="flex items-center gap-2">
        <h4 className="m-0 flex-1 text-xs font-semibold">{T.title}</h4>
        <Button ref={closeBtn} size="sm" variant={open ? 'outline' : 'default'} className="max-sm:min-h-11" aria-expanded={open} aria-controls="commands-terminal-body" onClick={open ? close : start}>
          {open ? T.close : T.open}
        </Button>
      </div>
      <p className="m-0 text-xs text-(--vscode-descriptionForeground)">{T.hint}</p>
      <div id="commands-terminal-body" hidden={!open} className="flex flex-col gap-2">
        {open ? (
          <>
            {recipes.length > 0 ? (
              <div role="group" aria-label={T.recipes} className="flex flex-col gap-1" data-commands-recipes>
                <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
                  {recipes.map((r) => (
                    <li key={r.id} className="flex min-w-0 flex-col gap-0.5">
                      <Button size="sm" variant="outline" className="min-h-11" data-recipe={r.id}
                        aria-label={T.recipeLabel(r.label, r.command)}
                        onClick={() => { armed.current = true; handle.current?.sendKeys(r.command); handle.current?.focus() }}>
                        {r.label}
                      </Button>
                    </li>
                  ))}
                </ul>
                <p className="m-0 text-xs text-(--vscode-descriptionForeground)">{T.recipesHint}</p>
                <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-xs text-(--vscode-descriptionForeground)">
                  {recipes.map((r) => <li key={r.id} className="min-w-0 [overflow-wrap:anywhere]">{r.description} <code className="font-mono">{r.command}</code></li>)}
                </ul>
              </div>
            ) : null}
            {phase === 'ended' || phase === 'failed' ? (
              <div role="alert" className="flex flex-col items-start gap-2 text-xs" data-terminal-error>
                <span>{phase === 'failed' ? T.failed : T.ended}</span>
                <Button size="sm" variant="outline" className="max-sm:min-h-11" onClick={start}>{T.retry}</Button>
              </div>
            ) : (
              <>
              <div className={BOX} role="region" aria-label={T.regionLabel(LEAVE_CHORD_LABEL)} aria-describedby="commands-terminal-leave">
                <Suspense fallback={<p className="m-2 text-xs" role="status">{T.opening}</p>}>
                  <TerminalCore key={attempt} ref={handle} id={SETUP_TERMINAL_ID} cwd="~" onOutput={onOutput} escapeChord onLeave={() => closeBtn.current?.focus()}
                    onExit={(_code, reason) => { clearTimeout(timer.current); setPhase(reason === 'failed' ? 'failed' : 'ended') }} />
                </Suspense>
              </div>
              <p id="commands-terminal-leave" className="m-0 text-xs text-(--vscode-descriptionForeground)">{T.leaveBefore}<kbd className="font-mono">{LEAVE_CHORD_LABEL}</kbd>{T.leaveAfter}</p>
              </>
            )}
            <p className="sr-only" role="status">{phase === 'connected' ? T.connected : phase === 'opening' ? T.opening : ''}</p>
          </>
        ) : null}
      </div>
    </section>
  )
}
