// Permission mode picker of the agent chat composer, labelled like the Claude Code VS Code picker.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { isPermissionMode, type AgentPermissionMode } from '../../shared/workspace.capabilities'
import type { ModePickerProps } from './agentChatCards.types'
import { errorText } from './toolCards'
import './agentChatCards.css'

/** Display label per mode, in picker order (`manual` is the CLI's `default`). */
export const MODE_LABEL: Record<AgentPermissionMode, string> = {
  manual: 'Ask before edits',
  acceptEdits: 'Edit automatically',
  plan: 'Plan mode',
  auto: 'Auto mode',
  bypassPermissions: 'Bypass permissions',
}
const MODES = Object.keys(MODE_LABEL) as AgentPermissionMode[]

/** Mode dropdown: shows the requested mode while the change is pending, the error with Retry if it fails. */
export function ModePicker({ mode, onChange, disabled }: ModePickerProps) {
  const [pending, setPending] = useState<AgentPermissionMode>()
  const [failed, setFailed] = useState<{ mode: AgentPermissionMode; error: string }>()
  const change = async (m: AgentPermissionMode): Promise<void> => {
    setPending(m)
    setFailed(undefined)
    try { await onChange(m) } catch (e) { setFailed({ mode: m, error: errorText(e) }) } finally { setPending(undefined) }
  }
  return (
    <div className="acc-mode">
      <Select value={pending ?? mode} disabled={disabled || pending !== undefined}
        onValueChange={(v) => { if (isPermissionMode(v) && v !== mode) void change(v) }}>
        <SelectTrigger size="sm" aria-label="Permission mode"><SelectValue /></SelectTrigger>
        <SelectContent>
          {MODES.map((m) => <SelectItem key={m} value={m}>{MODE_LABEL[m]}</SelectItem>)}
        </SelectContent>
      </Select>
      {pending && <span className="codicon codicon-loading codicon-modifier-spin" role="status" aria-label="Changing mode" />}
      {failed && (
        <span className="acc-row" role="alert">
          <span className="acc-error">{`Could not switch to ${MODE_LABEL[failed.mode]}: ${failed.error}`}</span>
          <Button variant="secondary" size="xs" disabled={disabled} onClick={() => void change(failed.mode)}>Retry</Button>
        </span>
      )}
    </div>
  )
}
