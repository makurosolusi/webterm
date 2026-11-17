// Audience of a skill in the UI: a badge for rows and cards, and the required kind select of the New and Duplicate forms.
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SKILL_AUDIENCES, type SkillAudience } from '../../server/central/contracts/skill.types'
import { CL } from './centralLabels'

/** Short badge (Central / Canvas) with the one-line meaning as its tooltip text. */
export function AudienceBadge({ audience }: { audience: SkillAudience }) {
  return <span className="ccp-badge" title={CL.skillAudienceHelp[audience]}>{CL.skillAudienceBadge[audience]}</span>
}

/** Required kind select: the current choice is always visible and its meaning is written below it. */
export function AudienceSelect({ value, onChange, disabled }: { value: SkillAudience; onChange: (a: SkillAudience) => void; disabled?: boolean }) {
  return (
    <div>
      <label className="ccp-cap">{CL.skillAudienceLabel}
        <Select value={value} disabled={disabled} onValueChange={(v) => onChange(v as SkillAudience)}>
          <SelectTrigger aria-label={CL.skillAudienceLabel}><SelectValue /></SelectTrigger>
          <SelectContent>
            {SKILL_AUDIENCES.map((a) => <SelectItem key={a} value={a}>{CL.skillAudienceChoice[a]}</SelectItem>)}
          </SelectContent>
        </Select>
      </label>
      <small role="status">{CL.skillAudienceHelp[value]}</small>
    </div>
  )
}
