// Agent Chat controls in the composer's bottom row (chat/chatComposer `toolbar`): mode chip, model name,
// effort, context meter. The session cost and last-turn tokens are in the meter's tooltip, not on screen.
// Conversation history is not a composer control: AgentChatHistory renders it in the node header.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentChatConfig, AgentChatContext, AgentChatModel, AgentChatSessionSummary } from '../../shared/agentChat.wire'
import { ContextMeter } from './contextMeter'
import { EffortPicker } from './effortPicker'
import { DEFAULT_MODEL, ModelPicker } from './modelPicker'
import { SessionPicker } from './sessionPicker'
import './agentChatToolbar.css'

const COST_DIGITS = 4

export interface AgentChatToolbarProps {
  /** The permission mode chip (the existing `<ModePicker>`), rendered first. */
  modePicker: ReactNode
  /** Current model/effort/thinking; undefined until the server sends a `config` event. */
  config?: AgentChatConfig
  /** Context window use after the last turn; the meter is hidden while undefined. */
  context?: AgentChatContext
  /** Session cost in USD (meter tooltip). */
  costUsd?: number
  /** Tokens of the last turn (meter tooltip). */
  tokens?: { input: number; output: number }
  loadModels: () => Promise<AgentChatModel[]>
  /** Applies a model/effort/thinking change; reject to show the error and revert. */
  onConfigChange: (patch: Partial<AgentChatConfig>) => Promise<void>
  loadSessions: () => Promise<AgentChatSessionSummary[]>
  onResumeSession: (sessionId: string) => Promise<void>
  onNewSession: () => Promise<void>
  /** Disables model, effort and history (e.g. while disconnected). */
  disabled?: boolean
  /** Opens the model or history picker from outside (`/model`, `/resume`); bump `n` for each request. */
  openPicker?: { which: 'model' | 'history'; n: number }
}

/** "Session cost $0.0123 · 1,200 in · 34 out", or undefined with nothing to say. */
export function usageDetail(costUsd?: number, tokens?: { input: number; output: number }): string | undefined {
  const parts = [
    costUsd !== undefined ? `Session cost $${costUsd.toFixed(COST_DIGITS)}` : undefined,
    tokens ? `last turn ${tokens.input.toLocaleString('en-US')} in · ${tokens.output.toLocaleString('en-US')} out` : undefined,
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : undefined
}

/** Composer-row controls; loads the model list once (prefetch) so the effort picker knows the current model's levels. */
export function AgentChatToolbar(props: AgentChatToolbarProps) {
  const { modePicker, config, context, loadModels, onConfigChange, disabled } = props
  const [models, setModels] = useState<AgentChatModel[]>()
  // Latest loader in a ref: an inline `loadModels` prop must not re-run the prefetch on every render.
  const loader = useRef(loadModels)
  useEffect(() => { loader.current = loadModels })
  const load = useCallback(async () => {
    const list = await loader.current()
    setModels(list)
    return list
  }, [])
  // Prefetch only: on failure the effort levels stay unknown and ModelPicker reloads and shows the error when opened.
  useEffect(() => { load().catch(() => undefined) }, [load])

  const modelValue = config?.model
  const current = models?.find((m) => m.value === (modelValue ?? DEFAULT_MODEL))
  const levels = models && (current?.efforts ?? [])

  return (
    <>
      {modePicker}
      <ModelPicker loadModels={load} models={models} value={modelValue} onChange={(model) => onConfigChange({ model })} disabled={disabled}
        openRequest={props.openPicker?.which === 'model' ? props.openPicker.n : undefined} />
      <EffortPicker levels={levels} effort={config?.effort} thinking={config?.thinking ?? false} onChange={onConfigChange} disabled={disabled} />
      <ContextMeter context={context} detail={usageDetail(props.costUsd, props.tokens)} />
    </>
  )
}

/** The node header's history button (portalled there by the view). */
export function AgentChatHistory(props: AgentChatToolbarProps) {
  return (
    <SessionPicker loadSessions={props.loadSessions} onResume={props.onResumeSession} onNew={props.onNewSession} disabled={props.disabled} compact
      openRequest={props.openPicker?.which === 'history' ? props.openPicker.n : undefined} />
  )
}
