// Effort + extended thinking menu of the agent chat footer (Claude Code VS Code "thinking" control).
import { DropdownMenu } from 'radix-ui'
import { IconTooltip } from '@/components/ui/icon-button'
import { portalContainer } from '@/components/vscode/portalContainer'
import type { AgentChatConfig } from '../../shared/agentChat.wire'
import { ChangeError, usePendingChange } from './modelPicker'
import './agentChatToolbar.css'

export interface EffortPickerProps {
  /** Effort levels of the current model; `[]` = the model has none, undefined = not known yet. */
  levels?: string[]
  /** Current effort; undefined = Claude Code's default. */
  effort?: string
  thinking: boolean
  onChange: (patch: Partial<AgentChatConfig>) => Promise<void>
  disabled?: boolean
  /** Icon-only trigger for narrow nodes. */
  compact?: boolean
}

/** "high" → "High". */
export const effortLabel = (level: string): string => level.charAt(0).toUpperCase() + level.slice(1)

/** Describes a patch for the error line, e.g. "effort High" / "thinking on". */
const describe = (patch: Partial<AgentChatConfig>): string =>
  patch.effort !== undefined ? `effort ${effortLabel(patch.effort)}` : `thinking ${patch.thinking ? 'on' : 'off'}`

/** Effort radio group (only when the model has levels) and an "Extended thinking" toggle; reverts on a failed change. */
export function EffortPicker({ levels, effort, thinking, onChange, disabled, compact }: EffortPickerProps) {
  const { pending, failed, run, dismiss } = usePendingChange(onChange)
  const shownEffort = pending?.value.effort ?? effort
  const shownThinking = pending?.value.thinking ?? thinking
  const hasLevels = !!levels?.length
  // Pending spinner (role=status) and ChangeError with Retry carry the feedback; this only starts the change.
  const setThinking = (c: boolean): void => { void run({ thinking: c }) }
  const summary = [hasLevels ? `Effort: ${shownEffort ? effortLabel(shownEffort) : 'Default'}` : undefined, `Extended thinking: ${shownThinking ? 'on' : 'off'}`]
    .filter(Boolean).join(' · ')
  const label = [hasLevels && shownEffort ? effortLabel(shownEffort) : undefined, shownThinking ? 'Thinking' : undefined].filter(Boolean).join(' · ') || 'Effort'

  return (
    <span className="act-picker">
      <DropdownMenu.Root modal={false}>
        <IconTooltip label={summary} disabled={disabled || !!pending} disabledReason={pending ? 'applying change' : undefined}>
          <DropdownMenu.Trigger asChild disabled={disabled || !!pending}>
            <button type="button" className="act-trigger" aria-label={`Effort and thinking: ${summary}`}>
              <span className={`codicon ${shownThinking ? 'codicon-lightbulb-sparkle' : 'codicon-lightbulb'}`} aria-hidden="true" />
              {!compact && <span className="act-trigger__label">{label}</span>}
              <span className="codicon codicon-chevron-down" aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
        </IconTooltip>
        <DropdownMenu.Portal container={portalContainer()}>
          <DropdownMenu.Content className="act-menu" side="top" align="start" sideOffset={4} aria-label="Effort and thinking">
            {hasLevels && (
              <>
                <DropdownMenu.Label className="act-menu__note">Effort</DropdownMenu.Label>
                <DropdownMenu.RadioGroup value={shownEffort ?? ''} onValueChange={(v) => { if (v !== effort) void run({ effort: v }) }}>
                  {levels!.map((l) => (
                    <DropdownMenu.RadioItem key={l} value={l} className="act-menu__item act-menu__item--radio">
                      <DropdownMenu.ItemIndicator className="act-menu__check"><span className="codicon codicon-check" aria-hidden="true" /></DropdownMenu.ItemIndicator>
                      {effortLabel(l)}
                    </DropdownMenu.RadioItem>
                  ))}
                </DropdownMenu.RadioGroup>
                <DropdownMenu.Separator className="act-menu__separator" />
              </>
            )}
            {levels?.length === 0 && <DropdownMenu.Label className="act-menu__note">This model has no effort levels</DropdownMenu.Label>}
            <DropdownMenu.CheckboxItem className="act-menu__item act-menu__item--radio" checked={shownThinking}
              onCheckedChange={setThinking}>
              <DropdownMenu.ItemIndicator className="act-menu__check"><span className="codicon codicon-check" aria-hidden="true" /></DropdownMenu.ItemIndicator>
              Extended thinking
            </DropdownMenu.CheckboxItem>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {pending && <span className="codicon codicon-loading codicon-modifier-spin" role="status" aria-label="Applying change" />}
      {failed && <ChangeError message={`Could not set ${describe(failed.value)}: ${failed.error}`} disabled={disabled} onRetry={() => void run(failed.value)} onDismiss={dismiss} />}
    </span>
  )
}
