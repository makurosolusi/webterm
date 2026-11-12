// "Working state" on the Memory tab: the pinned documents Central reads every turn, read first, edited on request.
import { Button } from '@/components/ui/button'
import { ActionButton, ActionResult, useAction } from '@/components/ui/action'
import { Textarea } from '@/components/ui/textarea'
import { useState } from 'react'
import { InboxApiError } from '../inboxTypes'
import { relativeTime } from '../SessionHistory.model'
import { CL } from './centralLabels'
import { STATE_CONFLICT, STATE_TOO_LARGE } from './centralControlApi'
import type { CentralControlClient, StateDoc, WorkingState } from './centralControlTypes'
import { centralErrorMessage, type Loaded } from './centralLoad'

const SAVING = 'Saving…'
const HUMAN_ACTOR = 'human:'
const authorOf = (actor: string): string => (actor.startsWith(HUMAN_ACTOR) ? CL.stateByYou : actor)

interface DocProps { name: string; projectId: string | null; doc: StateDoc | null; client: CentralControlClient; onChanged: () => void }

function StateCard({ name, projectId, doc, client, onChanged }: DocProps) {
  const [draft, setDraft] = useState<string | null>(null)
  // On a lost version check the draft stays open under the fresh text, so the user reviews before saving again.
  const save = useAction(async () => {
    if (draft === null) return
    try {
      await client.saveWorkingState(projectId, draft, doc?.version ?? 0)
    } catch (err) {
      if (err instanceof InboxApiError && err.code === STATE_CONFLICT) onChanged()
      throw err
    }
    setDraft(null)
    onChanged()
  }, {
    label: CL.stateSave,
    success: () => CL.stateSaved,
    failure: (err) => {
      const code = err instanceof InboxApiError ? err.code : null
      return code === STATE_CONFLICT ? CL.stateConflict : code === STATE_TOO_LARGE ? CL.stateTooLarge : centralErrorMessage(err, CL.actionFailed)
    },
  })
  const busy = save.busy

  return (
    <article className="ccp-card" aria-label={name} aria-busy={busy}>
      <header><strong>{name}</strong></header>
      {doc ? <p className="ccp-state__body">{doc.body}</p> : <p>{CL.stateEmpty}</p>}
      {doc && <p className="ccp-row__meta">{CL.stateMeta(doc.version, authorOf(doc.updatedBy), relativeTime(doc.updatedAt))}</p>}
      {draft === null && <Button type="button" size="sm" variant="secondary" aria-label={CL.stateEditLabel(name)} onClick={() => setDraft(doc?.body ?? '')}>{CL.stateEdit}</Button>}
      {draft !== null && (
        <div className="ccp-state__form">
          <Textarea aria-label={CL.stateTextLabel(name)} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="ccp-state__actions">
            <ActionButton type="button" size="sm" aria-label={CL.stateSaveLabel(name)} action={save} busyLabel={SAVING}>{CL.stateSave}</ActionButton>
            <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => setDraft(null)}>{CL.stateCancel}</Button>
          </div>
        </div>
      )}
      <ActionResult action={save} />
    </article>
  )
}

export interface MemoryWorkingStateProps { state: Loaded<WorkingState>; project: { id: string; name: string } | null; client: CentralControlClient }

/** The global document and, with a project picked, that project's. */
export function MemoryWorkingState({ state, project, client }: MemoryWorkingStateProps) {
  return (
    <>
      <h3>{CL.stateHeading}</h3>
      <p>{CL.stateIntro}</p>
      {state.error && <p role="alert" className="ccp-error">{state.error}</p>}
      {state.loading && !state.data && <p role="status">{CL.loading}</p>}
      {state.data && <StateCard name={CL.stateGlobal} projectId={null} doc={state.data.global} client={client} onChanged={state.reload} />}
      {state.data && project && <StateCard key={project.id} name={project.name} projectId={project.id} doc={state.data.project} client={client} onChanged={state.reload} />}
    </>
  )
}
