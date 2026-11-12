// F5-b sections of the "What agents remember" panel (AgentMemory.tsx): "Waiting for your OK", what the
// sleep-time consolidator proposed while agents were idle (Confirm all / per item / Dismiss = forget, so it is
// never proposed again), and "Shared notes", the blackboard (goal status, decisions) with agent proposals
// waiting for Confirm / Reject. The note key is picked from the keys already on the board (or typed).
// Split out of AgentMemory.tsx for the file-size budget; it imports the panel's request helper and labels
// back (a render-time-only cycle).
import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { ActionButton, ActionResult, errorCause, useAction, type Action } from '@/components/ui/action'
import { SettingsCombobox } from './SettingsCombobox'
import { ctl, MEMORY_TEXT, type MemoryAct, memoryRequest } from './AgentMemory.api'

export const PROPOSALS_PATH = '/api/memory-proposals'
export const BLACKBOARD_PATH = '/api/blackboard'
/** Recent list (Settings.inputHistory) of note keys typed in Shared notes. */
export const BOARD_KEY_FIELD_ID = 'memory.boardKey'

/** Mirror of the server `ProposalView` (src/server/memory/consolidator/consolidator.store.ts). */
export interface MemoryProposal {
  id: string; op: 'add' | 'update' | 'invalidate'; kind: string; text: string; targetText: string | null; untrusted: boolean; node: string | null
}
/** Mirror of the server `BlackboardEntry` (src/server/blackboard/blackboard.store.ts). */
export interface BoardEntry { id: string; key: string; value: string; status: string; by: string; at: number }

export const BOARD_TEXT = {
  proposalsTitle: 'Waiting for your OK',
  proposalsIntro: 'Suggested from recent sessions while agents were idle. Nothing here is remembered until you confirm it.',
  proposalsNone: 'Nothing is waiting.', confirmAll: 'Confirm all', dismiss: 'Dismiss', reviewNow: 'Review',
  ops: { add: 'new', update: 'update', invalidate: 'no longer true' } as Record<MemoryProposal['op'], string>,
  was: (text: string) => `was: ${text}`,
  tokens: (used: number, cap: number) => `Used in the last 24 h: ${used.toLocaleString()} of ${cap.toLocaleString()} tokens`,
  boardTitle: 'Shared notes',
  boardIntro: 'Notes agents share on this board, such as goal status and decisions. Changes agents suggest wait here for you.',
  boardNone: 'No shared notes yet.', boardKey: 'Key', boardValue: 'Value', boardSet: 'Set', reject: 'Reject',
  boardPlaceholder: 'goal:auth/status',
  proposedBy: (by: string) => `suggested by ${by}`,
} as const

/** Busy labels of the memory writes (shown on the button while it runs). */
export const MEMORY_BUSY = {
  confirm: 'Confirming…', confirmAll: 'Confirming…', dismiss: 'Dismissing…', review: 'Reviewing…', reject: 'Rejecting…', set: 'Setting…',
  mute: 'Saving…', forget: 'Forgetting…', save: 'Saving…', add: 'Remembering…',
} as const

/** One memory write: busy while it runs, then the result, or the failure with its reason and Retry. */
export function useMemoryAction(what: string, run: () => Promise<void>): Action<void> {
  return useAction(run, { label: what, failure: (e) => MEMORY_TEXT.failed(what, errorCause(e)) })
}

type MemoryButtonProps = Omit<React.ComponentProps<typeof ActionButton>, 'action' | 'busyLabel' | 'children'> & { what: string; busyLabel: string; run: () => Promise<void> }
/** A button for one memory write with its own result line (for buttons that stay mounted after the click). */
export function MemoryButton({ what, busyLabel, run, ...props }: MemoryButtonProps): React.JSX.Element {
  const action = useMemoryAction(what, run)
  return <><ActionButton size="sm" {...props} action={action} busyLabel={busyLabel}>{what}</ActionButton><ActionResult action={action} /></>
}

const listOf = <T,>(v: unknown, key: string): T[] | null => (v && Array.isArray((v as Record<string, unknown>)[key]) ? (v as Record<string, T[]>)[key]! : null)

/** The consolidator's proposals: each is a claim until confirmed; Dismiss forgets it (never proposed again). */
export function ProposalsSection({ act, tick }: { act: MemoryAct; tick: number }): React.JSX.Element | null {
  const [state, setState] = useState<{ proposals: MemoryProposal[]; used: number; cap: number } | null>(null)
  useEffect(() => {
    memoryRequest('GET', PROPOSALS_PATH).then((v) => {
      const proposals = listOf<MemoryProposal>(v, 'proposals')
      const o = v as { tokensToday?: number; dailyTokens?: number }
      setState(proposals ? { proposals, used: o.tokensToday ?? 0, cap: o.dailyTokens ?? 0 } : null)
    }).catch(() => setState(null)) // ledger off: the section is hidden, the rest of the panel still works
  }, [tick])
  if (!state) return null
  const confirmable = state.proposals.filter((p) => !p.untrusted)
  return (
    <div className="mt-3 flex flex-col gap-1 text-xs" data-testid="memory-proposals">
      <h4 className="font-semibold">{BOARD_TEXT.proposalsTitle}</h4>
      <p className="opacity-70" title={BOARD_TEXT.tokens(state.used, state.cap)}>{BOARD_TEXT.proposalsIntro}</p>
      <div className="flex gap-1">
        {confirmable.length > 1 ? <MemoryButton what={BOARD_TEXT.confirmAll} busyLabel={MEMORY_BUSY.confirmAll} run={() => act(BOARD_TEXT.confirmAll, 'POST', `${PROPOSALS_PATH}/confirm-all`)} /> : null}
        <MemoryButton variant="secondary" what={BOARD_TEXT.reviewNow} busyLabel={MEMORY_BUSY.review} run={() => act(BOARD_TEXT.reviewNow, 'POST', `${PROPOSALS_PATH}/run`)} />
      </div>
      {state.proposals.length === 0 ? <p className="opacity-70">{BOARD_TEXT.proposalsNone}</p> : (
        <ul className="flex flex-col gap-1">
          {state.proposals.map((p) => (
            <li key={p.id} data-proposal={p.id} className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{BOARD_TEXT.ops[p.op]}</Badge>
              <span className="flex-1 break-words">{p.text}{p.targetText ? <span className="opacity-70"> · {BOARD_TEXT.was(p.targetText)}</span> : null}</span>
              {p.untrusted ? <Badge variant="outline">{MEMORY_TEXT.untrusted}</Badge>
                : <MemoryButton what={MEMORY_TEXT.confirm} busyLabel={MEMORY_BUSY.confirm} run={() => act(MEMORY_TEXT.confirm, 'POST', `${PROPOSALS_PATH}/${encodeURIComponent(p.id)}/confirm`)} />}
              <MemoryButton variant="secondary" what={BOARD_TEXT.dismiss} busyLabel={MEMORY_BUSY.dismiss} run={() => act(BOARD_TEXT.dismiss, 'POST', ctl(p.id, 'forget'))} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** The shared blackboard: current values, agent proposals (Confirm / Reject), and a human Set. */
export function BoardSection({ act, tick }: { act: MemoryAct; tick: number }): React.JSX.Element | null {
  const [board, setBoard] = useState<{ entries: BoardEntry[]; proposals: BoardEntry[] } | null>(null)
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  useEffect(() => {
    memoryRequest('GET', BLACKBOARD_PATH).then((v) => {
      const entries = listOf<BoardEntry>(v, 'entries')
      setBoard(entries ? { entries, proposals: listOf<BoardEntry>(v, 'proposals') ?? [] } : null)
    }).catch(() => setBoard(null)) // ledger off: hidden
  }, [tick])
  if (!board) return null
  const prop = (id: string, verb: string): string => `${BLACKBOARD_PATH}/proposals/${encodeURIComponent(id)}/${verb}`
  return (
    <div className="mt-3 flex flex-col gap-1 text-xs" data-testid="memory-blackboard">
      <h4 className="font-semibold">{BOARD_TEXT.boardTitle}</h4>
      <p className="opacity-70">{BOARD_TEXT.boardIntro}</p>
      {board.entries.length === 0 ? <p className="opacity-70">{BOARD_TEXT.boardNone}</p> : (
        <ul className="flex flex-col gap-1">
          {board.entries.map((e) => <li key={e.id} data-board={e.key}><code>{e.key}</code>: {e.value}</li>)}
        </ul>
      )}
      {board.proposals.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {board.proposals.map((e) => (
            <li key={e.id} data-board-proposal={e.id} className="flex flex-wrap items-center gap-2">
              <span className="flex-1 break-words"><code>{e.key}</code>: {e.value} <span className="opacity-70">· {BOARD_TEXT.proposedBy(e.by)}</span></span>
              <MemoryButton what={MEMORY_TEXT.confirm} busyLabel={MEMORY_BUSY.confirm} run={() => act(MEMORY_TEXT.confirm, 'POST', prop(e.id, 'confirm'))} />
              <MemoryButton variant="secondary" what={BOARD_TEXT.reject} busyLabel={MEMORY_BUSY.reject} run={() => act(BOARD_TEXT.reject, 'POST', prop(e.id, 'reject'))} />
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center gap-2">
        <span className="w-48">
          <SettingsCombobox ariaLabel={BOARD_TEXT.boardKey} fieldId={BOARD_KEY_FIELD_ID} mono placeholder={BOARD_TEXT.boardPlaceholder} maxLength={160}
            presets={[...new Set(board.entries.map((e) => e.key))].map((value) => ({ value }))} value={key} onDraft={setKey} onCommit={setKey} />
        </span>
        <Input aria-label={BOARD_TEXT.boardValue} value={value} maxLength={500} onChange={(e) => setValue(e.target.value)} className="min-w-32 flex-1" />
        <MemoryButton disabled={key.trim() === '' || value.trim() === ''} what={BOARD_TEXT.boardSet} busyLabel={MEMORY_BUSY.set}
          run={async () => { await act(BOARD_TEXT.boardSet, 'POST', BLACKBOARD_PATH, { key: key.trim(), value: value.trim() }); setValue('') }} />
      </div>
    </div>
  )
}
