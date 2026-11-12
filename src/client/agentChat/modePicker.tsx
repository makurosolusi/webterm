// Permission mode chip of the agent chat composer row: a quiet icon + short label (like the Central mode chip,
// ApprovalModeControl), whose menu lists the modes with the Claude Code VS Code labels. Bypass reads red.
import { useState } from 'react'
import { DropdownMenu } from 'radix-ui'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-button'
import { portalContainer } from '@/components/vscode/portalContainer'
import { type AgentPermissionMode } from '../../shared/workspace.capabilities'
import type { ModePickerProps } from './agentChatCards.types'
import { errorText } from './toolCards'
import './agentChatCards.css'
import './agentChatToolbar.css'

/** Menu label per mode, in picker order (`manual` is the CLI's `default`). */
export const MODE_LABEL: Record<AgentPermissionMode, string> = {
  manual: 'Ask before edits',
  acceptEdits: 'Edit automatically',
  plan: 'Plan mode',
  auto: 'Auto mode',
  bypassPermissions: 'Bypass permissions',
}
/** Chip text: one short word, the full label is in the tooltip and accessible name. */
const MODE_SHORT: Record<AgentPermissionMode, string> = { manual: 'Ask', acceptEdits: 'Edits', plan: 'Plan', auto: 'Auto', bypassPermissions: 'Bypass' }
const MODE_ICON: Record<AgentPermissionMode, string> = { manual: 'shield', acceptEdits: 'edit', plan: 'checklist', auto: 'workspace-trusted', bypassPermissions: 'warning' }
const MODES = Object.keys(MODE_LABEL) as AgentPermissionMode[]

/** Mode chip: shows the requested mode while the change is pending, the error with Retry if it fails. */
export function ModePicker({ mode, onChange, disabled }: ModePickerProps) {
  const [pending, setPending] = useState<AgentPermissionMode>()
  const [failed, setFailed] = useState<{ mode: AgentPermissionMode; error: string }>()
  const change = async (m: AgentPermissionMode): Promise<void> => {
    setPending(m)
    setFailed(undefined)
    try { await onChange(m) } catch (e) { setFailed({ mode: m, error: errorText(e) }) } finally { setPending(undefined) }
  }
  // Feedback lives in the picker: the spinner (role=status) while pending, then this alert again on a new failure.
  const retry = (): void => { if (failed) void change(failed.mode) }
  const shown = pending ?? mode
  const off = disabled || pending !== undefined
  return (
    <span className="act-picker acc-mode" data-mode={shown}>
      <DropdownMenu.Root modal={false}>
        <IconTooltip label={`Permission mode: ${MODE_LABEL[shown]}`} disabled={off} disabledReason={pending ? 'switching mode' : undefined}>
          <DropdownMenu.Trigger asChild disabled={off}>
            <button type="button" className="act-trigger acc-mode__trigger" aria-label={`Permission mode: ${MODE_LABEL[shown]}`}>
              <span className={`codicon codicon-${MODE_ICON[shown]}`} aria-hidden="true" />
              <span className="act-trigger__label">{MODE_SHORT[shown]}</span>
            </button>
          </DropdownMenu.Trigger>
        </IconTooltip>
        <DropdownMenu.Portal container={portalContainer()}>
          <DropdownMenu.Content className="act-menu" side="top" align="start" sideOffset={4} aria-label="Permission modes">
            <DropdownMenu.RadioGroup value={shown} onValueChange={(v) => { if (v !== mode) void change(v as AgentPermissionMode) }}>
              {MODES.map((m) => (
                <DropdownMenu.RadioItem key={m} value={m} className="act-menu__item act-menu__item--radio">
                  <DropdownMenu.ItemIndicator className="act-menu__check"><span className="codicon codicon-check" aria-hidden="true" /></DropdownMenu.ItemIndicator>
                  {MODE_LABEL[m]}
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {pending && <span className="codicon codicon-loading codicon-modifier-spin" role="status" aria-label="Changing mode" />}
      {failed && (
        <span className="acc-row" role="alert">
          <span className="acc-error">{`Could not switch to ${MODE_LABEL[failed.mode]}: ${failed.error}`}</span>
          <Button variant="secondary" size="xs" disabled={disabled} onClick={retry}>Retry</Button>
        </span>
      )}
    </span>
  )
}
