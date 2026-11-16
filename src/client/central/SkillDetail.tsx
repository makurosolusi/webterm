// Read-only detail of one library row: what it is for, the tools it asks for, and its instructions.
import { Button } from '@/components/ui/button'
import { CL } from './centralLabels'
import type { SkillReviewRow } from './centralControlTypes'

export default function SkillDetail({ row, onClose }: { row: SkillReviewRow; onClose: () => void }) {
  const { record, description, body } = row
  return (
    <article className="ccp-card" aria-label={`${record.name} ${record.version} details`}>
      <header>
        <strong>{record.name}</strong> <span>{record.version}</span>
        <span className="ccp-badge">{record.status}</span> <span className="ccp-badge">{record.origin}</span>
        <Button type="button" size="xs" variant="secondary" onClick={onClose}>{CL.skillBack}</Button>
      </header>
      {description && <p>{description}</p>}
      <p>{CL.skillCaps}: {record.caps.length > 0 ? record.caps.join(', ') : CL.skillCapsNone}</p>
      {record.origin === 'builtin' && <p>{CL.skillBuiltinReadOnly}</p>}
      {body ? <pre className="ccp-diff" tabIndex={0} aria-label={CL.skillInstructions}>{body}</pre> : <p>{CL.skillNoBody}</p>}
    </article>
  )
}
