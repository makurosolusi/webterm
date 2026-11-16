// Model dropdown of the agent chat composer row (Claude Code VS Code "model" picker), plus the
// pending/failure pattern the footer's other pickers share.
import { useEffect, useState } from 'react'
import { DropdownMenu } from 'radix-ui'
import { Button } from '@/components/ui/button'
import { IconButton, IconTooltip } from '@/components/ui/icon-button'
import { portalContainer } from '@/components/vscode/portalContainer'
import type { AgentChatModel } from '../../shared/agentChat.wire'
import { errorText } from './toolCards'
import './agentChatToolbar.css'

/** Runs one async change at a time: `pending` holds the requested value, `failed` the last rejection. */
export function usePendingChange<T>(apply: (value: T) => Promise<void>) {
  const [pending, setPending] = useState<{ value: T }>()
  const [failed, setFailed] = useState<{ value: T; error: string }>()
  const run = async (value: T): Promise<void> => {
    setPending({ value })
    setFailed(undefined)
    try { await apply(value) } catch (e) { setFailed({ value, error: errorText(e) }) } finally { setPending(undefined) }
  }
  return { pending, failed, run, dismiss: () => setFailed(undefined) }
}

/** Inline alert with Retry and Dismiss, shown after a rejected change (the shown value has reverted). */
export function ChangeError({ message, onRetry, onDismiss, disabled }: { message: string; onRetry: () => void; onDismiss: () => void; disabled?: boolean }) {
  return (
    <span className="act-alert" role="alert">
      <span className="act-alert__text">{message}</span>
      <Button variant="secondary" size="xs" disabled={disabled} onClick={onRetry}>Retry</Button>
      <IconButton label="Dismiss error" size="icon-xs" onClick={onDismiss}><span className="codicon codicon-close" aria-hidden="true" /></IconButton>
    </span>
  )
}

/** Shown on every Fable entry (picker menus): it needs a person's grant and costs the most. */
export const FABLE_NOTE = 'Needs approval · highest cost'
export const isFableValue = (value: string): boolean => value.toLowerCase().includes('fable')

/** Value Claude Code lists for "use the default model"; an unset model maps to it. */
export const DEFAULT_MODEL = 'default'

/** Unset model before the list loads. Once loaded, the server names the `default` entry after what the
 *  ladder resolved for this node's workspace (agentChat.ladder.ts), e.g. "Auto (ladder: Sonnet · medium)". */
export const AUTO_MODEL_LABEL = 'Auto (model ladder)'

export interface ModelPickerProps {
  /** Fetches the selectable models; called when the menu opens until it succeeds. */
  loadModels: () => Promise<AgentChatModel[]>
  /** Already-known list (e.g. a parent's prefetch); the picker then skips its own load. */
  models?: AgentChatModel[]
  /** Current model value; undefined = Claude Code's default (the list's `default` entry, if any). */
  value?: string
  onChange: (value: string) => Promise<void>
  disabled?: boolean
  /** Bump to open the menu from outside (the `/model` command); ignored while disabled. */
  openRequest?: number
}

/** Model dropdown: loads on open (loading / error + Retry), checks the current model, reverts on a failed change. */
/** The trigger always shows the model name as text (truncated on a narrow row), never an icon only. */
export function ModelPicker({ loadModels, models: known, value, onChange, disabled, openRequest }: ModelPickerProps) {
  const [loaded, setLoaded] = useState<AgentChatModel[]>()
  const models = known ?? loaded
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string>()
  const { pending, failed, run, dismiss } = usePendingChange(onChange)
  const load = async (): Promise<void> => {
    setLoading(true)
    setLoadError(undefined)
    try { setLoaded(await loadModels()) } catch (e) { setLoadError(errorText(e)) } finally { setLoading(false) }
  }
  const [open, setOpen] = useState(false)
  const openChange = (next: boolean): void => {
    setOpen(next)
    if (next && !models && !loading) void load()
  }
  // Only a new request opens it; `openChange` is rebuilt every render, so it is not a dependency.
  useEffect(() => { if (openRequest && !disabled && !pending) openChange(true) }, [openRequest])
  const shown = pending ? pending.value : value
  const nameOf = (v?: string) => models?.find((m) => m.value === (v ?? DEFAULT_MODEL))?.displayName ?? v ?? AUTO_MODEL_LABEL
  const name = nameOf(shown)

  return (
    <span className="act-picker">
      <DropdownMenu.Root modal={false} open={open} onOpenChange={openChange}>
        <IconTooltip label={`Model: ${name}`} disabled={disabled || !!pending} disabledReason={pending ? 'switching model' : undefined}>
          <DropdownMenu.Trigger asChild disabled={disabled || !!pending}>
            <button type="button" className="act-trigger act-trigger--model" aria-label={`Model: ${name}`}>
              <span className="act-trigger__label">{name}</span>
              <span className="codicon codicon-chevron-down" aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
        </IconTooltip>
        <DropdownMenu.Portal container={portalContainer()}>
          <DropdownMenu.Content className="act-menu" side="top" align="start" sideOffset={4} aria-label="Models">
            {loading && <DropdownMenu.Label className="act-menu__note" role="status">Loading models…</DropdownMenu.Label>}
            {loadError && !loading && (
              <>
                <DropdownMenu.Label className="act-menu__note act-menu__note--error" role="alert">{`Could not load models: ${loadError}`}</DropdownMenu.Label>
                <DropdownMenu.Item className="act-menu__item" onSelect={(e) => { e.preventDefault(); void load() }}>
                  <span className="codicon codicon-refresh" aria-hidden="true" />Retry
                </DropdownMenu.Item>
              </>
            )}
            {models && !loading && models.length === 0 && <DropdownMenu.Label className="act-menu__note">No models available</DropdownMenu.Label>}
            {models && !loading && (
              <DropdownMenu.RadioGroup value={shown ?? DEFAULT_MODEL} onValueChange={(v) => { if (v !== (value ?? DEFAULT_MODEL)) void run(v) }}>
                {models.map((m) => (
                  <DropdownMenu.RadioItem key={m.value} value={m.value} className="act-menu__item act-menu__item--radio">
                    <DropdownMenu.ItemIndicator className="act-menu__check"><span className="codicon codicon-check" aria-hidden="true" /></DropdownMenu.ItemIndicator>
                    <span className="act-menu__text">
                      <span>{m.displayName}</span>
                      {isFableValue(m.value) ? <span className="act-menu__desc">{[m.description, FABLE_NOTE].filter(Boolean).join(' · ')}</span>
                        : m.description && <span className="act-menu__desc">{m.description}</span>}
                    </span>
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {pending && <span className="codicon codicon-loading codicon-modifier-spin" role="status" aria-label="Switching model" />}
      {failed && <ChangeError message={`Could not switch to ${nameOf(failed.value)}: ${failed.error}`} disabled={disabled} onRetry={() => void run(failed.value)} onDismiss={dismiss} />}
    </span>
  )
}
