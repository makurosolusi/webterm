// Footer row of the agent chat node: mode, model, effort/thinking, history, context meter, cost.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentChatConfig, AgentChatContext, AgentChatModel, AgentChatSessionSummary } from '../../shared/agentChat.wire'
import { ContextMeter } from './contextMeter'
import { EffortPicker } from './effortPicker'
import { DEFAULT_MODEL, ModelPicker } from './modelPicker'
import { SessionPicker } from './sessionPicker'
import './agentChatToolbar.css'

/** Footer width (px) below which the pickers drop their text labels and the token count hides. */
export const FOOTER_COMPACT_PX = 420
const COST_DIGITS = 4

export interface AgentChatFooterProps {
  /** The permission mode picker (the existing `<ModePicker>`), rendered first. */
  modePicker: ReactNode
  /** Current model/effort/thinking; undefined until the server sends a `config` event. */
  config?: AgentChatConfig
  /** Context window use after the last turn; the meter is hidden while undefined. */
  context?: AgentChatContext
  /** Session cost in USD; hidden while undefined. */
  costUsd?: number
  /** Tokens of the last turn; hidden while undefined and on narrow footers. */
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

/** True while `ref`'s element is narrower than `px`. */
function useNarrow(ref: React.RefObject<HTMLElement | null>, px: number): boolean {
  const [narrow, setNarrow] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width > 0 && entry.contentRect.width < px))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, px])
  return narrow
}

/** Composed footer; loads the model list once (prefetch) so the effort picker knows the current model's levels. */
export function AgentChatFooter(props: AgentChatFooterProps) {
  const { modePicker, config, context, costUsd, tokens, loadModels, onConfigChange, disabled } = props
  const ref = useRef<HTMLElement>(null)
  const compact = useNarrow(ref, FOOTER_COMPACT_PX)
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
    <footer ref={ref} className={`agent-chat-footer act-footer${compact ? ' act-footer--compact' : ''}`} data-compact={compact || undefined}>
      {modePicker}
      <ModelPicker loadModels={load} models={models} value={modelValue} onChange={(model) => onConfigChange({ model })} disabled={disabled} compact={compact}
        openRequest={props.openPicker?.which === 'model' ? props.openPicker.n : undefined} />
      <EffortPicker levels={levels} effort={config?.effort} thinking={config?.thinking ?? false} onChange={onConfigChange} disabled={disabled} compact={compact} />
      <SessionPicker loadSessions={props.loadSessions} onResume={props.onResumeSession} onNew={props.onNewSession} disabled={disabled} compact={compact}
        openRequest={props.openPicker?.which === 'history' ? props.openPicker.n : undefined} />
      <span className="act-footer__end">
        <ContextMeter context={context} compact={compact} />
        {costUsd !== undefined && <span className="agent-chat-footer__item" title="Session cost">{`$${costUsd.toFixed(COST_DIGITS)}`}</span>}
        {tokens && !compact && (
          <span className="agent-chat-footer__item" title="Tokens of the last turn (input incl. cache / output)">
            {`${tokens.input.toLocaleString('en-US')} in · ${tokens.output.toLocaleString('en-US')} out`}
          </span>
        )}
      </span>
    </footer>
  )
}
