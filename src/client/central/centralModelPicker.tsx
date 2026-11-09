// The Central chat header's model picker: the badge ("sonnet · medium · T2") is the trigger, its menu
// picks the conversation's model + effort (Claude Code's `/model` picker); bare `/model` opens it.
import { useEffect, useRef, useState } from 'react'
import { DropdownMenu } from 'radix-ui'
import { IconTooltip } from '@/components/ui/icon-button'
import { portalContainer } from '@/components/vscode/portalContainer'
import { AUTO_MODEL_LABEL, ChangeError, usePendingChange } from '../agentChat/modelPicker'
import { effortLabel } from '../agentChat/effortPicker'
import { errorText } from '../agentChat/toolCards'
import { EFFORT_ARGS, MODEL_ARGS, type EffortArg, type ModelArg } from './centralCommands'
import { type CentralModelState, fetchCentralModel, setCentralModel } from './centralModel'
import '../agentChat/agentChatToolbar.css'

export interface CentralModelPickerProps {
  conversationId: string
  /** A new value reloads the badge (after a turn settles or a `/model` choice). */
  refreshKey: number
  /** Bump to open the menu from outside (bare `/model`); ignored while a change is pending. */
  openRequest?: number
  /** Called once the server stored a choice. */
  onModelSet?: () => void
  /** Test seams; default to the live model route. */
  load?: typeof fetchCentralModel
  setModel?: typeof setCentralModel
}

interface Choice { model: ModelArg; effort?: EffortArg }

const NO_EFFORT = 'default'
const choiceOf = (s: CentralModelState | null): Choice | undefined => s ? {
  model: (s.override ? s.override.model : 'auto') as ModelArg,
  ...(s.override?.effort ? { effort: s.override.effort as EffortArg } : {}),
} : undefined
const choiceLabel = (c: Choice): string => [effortLabel(c.model), c.effort && effortLabel(c.effort)].filter(Boolean).join(' · ')

/** Keyed on the conversation, so a pending or failed change never carries over to another chat. */
export function CentralModelPicker(props: CentralModelPickerProps) {
  return <Picker key={props.conversationId} {...props} />
}

function Picker({ conversationId, refreshKey, openRequest, onModelSet, load = fetchCentralModel, setModel = setCentralModel }: CentralModelPickerProps) {
  const [state, setState] = useState<CentralModelState | null>(null)
  const [loadError, setLoadError] = useState<string>()
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const abort = new AbortController()
    load(conversationId, abort.signal).then(
      (s) => { if (!abort.signal.aborted) { setState(s); setLoadError(undefined) } },
      (e: unknown) => { if (!abort.signal.aborted) setLoadError(errorText(e)) },
    )
    return () => abort.abort()
  }, [conversationId, refreshKey, retry, load])
  const reload = (): void => { setLoadError(undefined); setState(null); setRetry((n) => n + 1) }

  const { pending, failed, run, dismiss } = usePendingChange(async (c: Choice) => {
    setState(await setModel(conversationId, c.model, c.effort))
    onModelSet?.()
  })
  const [open, setOpen] = useState(false)
  // Only a request made after mount opens it (a remount for another chat must not reopen it).
  const seen = useRef(openRequest)
  useEffect(() => {
    if (!openRequest || openRequest === seen.current) return
    seen.current = openRequest
    if (!pending) setOpen(true)
  }, [openRequest])

  const current = choiceOf(state)
  const shown = pending?.value ?? current
  const loading = !state && !loadError
  const text = state
    ? `${[state.alias ?? 'default', state.effort, state.tier].filter(Boolean).join(' · ')}${state.pending ? ' · next session' : ''}`
    : loading ? 'Model…' : 'Model'
  const title = state?.pending ? 'New model starts with a fresh session on your next message'
    : loadError ? `Could not load the model: ${loadError}` : 'Model for this chat (/model to change)'
  const pick = (c: Choice): void => { if (current && choiceLabel(c) !== choiceLabel(current)) void run(c) }

  return (
    <span className="act-picker chat-model-badge">
      <DropdownMenu.Root modal={false} open={open} onOpenChange={setOpen}>
        <IconTooltip label={title} disabled={!!pending} disabledReason={pending ? 'switching model' : undefined}>
          <DropdownMenu.Trigger asChild disabled={!!pending}>
            <button type="button" className="act-trigger" aria-label={`Model: ${text}`} aria-busy={loading || !!pending}>
              <span className="act-trigger__label">{text}</span>
              <span className="codicon codicon-chevron-down" aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
        </IconTooltip>
        <DropdownMenu.Portal container={portalContainer()}>
          <DropdownMenu.Content className="act-menu" side="bottom" align="end" sideOffset={4}>
            {loading && <DropdownMenu.Label className="act-menu__note" role="status">Loading model…</DropdownMenu.Label>}
            {loadError && (
              <>
                <DropdownMenu.Label className="act-menu__note act-menu__note--error" role="alert">{`Could not load the model: ${loadError}`}</DropdownMenu.Label>
                <DropdownMenu.Item className="act-menu__item" onSelect={(e) => { e.preventDefault(); reload() }}>
                  <span className="codicon codicon-refresh" aria-hidden="true" />Retry
                </DropdownMenu.Item>
              </>
            )}
            {shown && !loadError && (
              <>
                <DropdownMenu.Label className="act-menu__note">Model</DropdownMenu.Label>
                <DropdownMenu.RadioGroup value={shown.model}
                  onValueChange={(v) => pick(v === 'auto' ? { model: 'auto' } : { model: v as ModelArg, ...(shown.effort ? { effort: shown.effort } : {}) })}>
                  {MODEL_ARGS.map((m) => <Radio key={m} value={m} label={m === 'auto' ? AUTO_MODEL_LABEL : effortLabel(m)} />)}
                </DropdownMenu.RadioGroup>
                <DropdownMenu.Separator className="act-menu__separator" />
                <DropdownMenu.Label className="act-menu__note">{shown.model === 'auto' ? 'Effort (Auto picks it)' : 'Effort'}</DropdownMenu.Label>
                <DropdownMenu.RadioGroup value={shown.effort ?? NO_EFFORT}
                  onValueChange={(v) => pick({ model: shown.model, ...(v !== NO_EFFORT ? { effort: v as EffortArg } : {}) })}>
                  {[NO_EFFORT, ...EFFORT_ARGS].map((e) => <Radio key={e} value={e} label={effortLabel(e)} disabled={shown.model === 'auto'} />)}
                </DropdownMenu.RadioGroup>
              </>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {pending && <span className="codicon codicon-loading codicon-modifier-spin" role="status" aria-label="Switching model" />}
      {failed && <ChangeError message={`Could not switch to ${choiceLabel(failed.value)}: ${failed.error}`} onRetry={() => void run(failed.value)} onDismiss={dismiss} />}
    </span>
  )
}

function Radio({ value, label, disabled }: { value: string; label: string; disabled?: boolean }) {
  return (
    <DropdownMenu.RadioItem value={value} disabled={disabled} className="act-menu__item act-menu__item--radio">
      <DropdownMenu.ItemIndicator className="act-menu__check"><span className="codicon codicon-check" aria-hidden="true" /></DropdownMenu.ItemIndicator>
      {label}
    </DropdownMenu.RadioItem>
  )
}
