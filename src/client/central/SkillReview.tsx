// Skill review: lint result, diff, and the two human-only actions. Approving activates a skill
// (R3), so it needs the typed phrase; rollback only re-points `active/<name>` and is one click.
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useState } from 'react'
import { inboxErrorMessage } from '../inboxApi'
import { CONFIRM_PHRASE } from '../inboxApprovalDialog'
import { CL } from './centralLabels'
import { centralControlApi } from './centralControlApi'
import type { CentralControlClient, SkillReviewRow } from './centralControlTypes'
import { useLoad } from './centralLoad'

const diffClass = (line: string): string => (line.startsWith('+') ? 'ccp-diff--add' : line.startsWith('-') ? 'ccp-diff--del' : '')

function SkillItem({ row, client, onDone }: { row: SkillReviewRow; client: CentralControlClient; onDone: () => void }) {
  const { record, lint, diff } = row
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)
  const canApprove = typed === CONFIRM_PHRASE && lint.ok
  const act = async (fn: () => Promise<void>) => {
    try { await fn(); onDone() } catch (err) { setError(inboxErrorMessage(err)) }
  }
  const pending = record.status === 'pending_approval' || record.status === 'evaluated'
  return (
    <article className="ccp-card" aria-label={`${record.name} ${record.version}`}>
      <header>
        <strong>{record.name}</strong> <span>{record.version}</span>
        <span className="ccp-badge">{record.status}</span> <span className="ccp-badge">{record.origin}</span>
        {record.evalScore !== null && <span>{CL.skillScore}: {record.evalScore}</span>}
      </header>
      <p className={lint.ok ? 'ccp-ok' : 'ccp-error'} role="status">{lint.ok ? CL.skillLintOk : CL.skillLintFail}</p>
      {lint.findings.length > 0 && <ul aria-label={CL.skillLint}>{lint.findings.map((f) => <li key={f}>{f}</li>)}</ul>}
      {diff && (
        <pre className="ccp-diff" tabIndex={0} aria-label={CL.skillDiff}>
          {diff.split('\n').map((l, i) => <span key={i} className={diffClass(l)}>{l}{'\n'}</span>)}
        </pre>
      )}
      {pending && (
        <>
          <label className="ccp-confirm-input">{CL.confirmLabel(CONFIRM_PHRASE)}
            <Input value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
          </label>
          <Button type="button" size="sm" disabled={!canApprove} onClick={() => void act(() => client.approveSkill(record.name, record.version))}>{CL.skillApprove}</Button>
        </>
      )}
      {record.status === 'active' && <Button type="button" size="sm" variant="secondary" onClick={() => void act(() => client.rollbackSkill(record.name))}>{CL.skillRollback}</Button>}
      {error && <p role="alert" className="ccp-error">{error}</p>}
    </article>
  )
}

export default function SkillReview({ client = centralControlApi }: { client?: CentralControlClient }) {
  const list = useLoad((s) => client.listSkills(s))
  return (
    <section className="ccp-section" aria-labelledby="ccp-skills-h">
      <h3 id="ccp-skills-h">{CL.skillsHeading}</h3>
      {list.error && <p role="alert" className="ccp-error">{list.error}</p>}
      {list.loading && !list.data && <p role="status">{CL.loading}</p>}
      {list.data?.length === 0 && <p>{CL.empty}</p>}
      {list.data?.map((r) => <SkillItem key={`${r.record.name}@${r.record.version}`} row={r} client={client} onDone={list.reload} />)}
    </section>
  )
}
