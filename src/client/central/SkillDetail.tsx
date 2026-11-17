// Detail of one library row: what it is for, the tools it asks for, its instructions, and the human actions
// (on/off switch for an active skill, "Ask the agent to revise"). Nothing here edits text: skills are written by agents.
import { ActionResult, useAction } from '@/components/ui/action'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { type ReactNode, useRef, useState } from 'react'
import { CL } from './centralLabels'
import { AudienceBadge } from './SkillAudience'
import SkillContent from './SkillContent'
import { SD } from './skillDetail.labels'
import './skillDetail.css'
import type { CentralControlClient, SkillReviewRow } from './centralControlTypes'
import { titleOf } from './skillLibraryModel'
import { useNodeActions } from '../nodeActions'
import { SN } from '../skillNode.labels'
import { SP } from '../skillPalette.labels'
import { MAX_ATTACHED_SKILLS } from '../../shared/skillPorts'

interface Props {
  row: SkillReviewRow
  client: CentralControlClient
  onClose: () => void
  /** The list changed (switch flipped): reload it. */
  onChanged: () => void
  /** The "Ask the agent ..." control for this skill; the library picks the author (Central chat or canvas node) by kind. */
  revise?: ReactNode
}

export default function SkillDetail({ row, client, onClose, onChanged, revise }: Props) {
  const { record, description, body } = row
  const [on, setOn] = useState(record.enabled !== false)
  const target = useRef(on)
  const toggle = useAction(async () => { await client.setSkillEnabled(record.name, target.current); setOn(target.current); onChanged() }, { label: CL.skillEnabled, failure: () => CL.skillEnabledFailed })
  const active = record.status === 'active'
  // Canvas skills only, and only while active and switched on: a skill node of anything else would be Unavailable at once.
  const { addSkillNode } = useNodeActions()
  const [added, setAdded] = useState<string | null>(null)
  const canAdd = active && on && record.audience === 'canvas'
  const addToCanvas = () => {
    const r = addSkillNode?.({ name: record.name, version: record.version })
    setAdded(r === undefined ? SN.addToCanvasNoBoard : r.status === 'no_board' ? SN.addToCanvasNoBoard : r.status === 'attached' ? SN.addedAttached : r.status === 'limit' ? SN.addedLimit(MAX_ATTACHED_SKILLS) : r.status === 'exists' ? SP.exists('the selected agent') : SN.added)
  }
  const builtin = record.origin === 'builtin'
  const changed = record.approvedAt ?? record.createdAt
  const meta: Array<[string, ReactNode]> = [
    [SD.metaKind, <AudienceBadge key="k" audience={record.audience} />],
    [SD.metaOrigin, SD.originName[record.origin] ?? record.origin],
    [SD.metaVersion, record.version],
    [SD.metaStatus, record.status],
    ...(changed > 0 ? [[SD.metaChanged, <time key="t" dateTime={new Date(changed).toISOString()}>{new Date(changed).toLocaleDateString()}</time>] as [string, ReactNode]] : []),
    [SD.metaEnabled, on ? SD.yes : SD.no],
  ]
  const titled = titleOf(row)
  return (
    <article className="ccp-card" aria-label={`${record.name} ${record.version} details`}>
      <header className="skd-head">
        <strong>{titled}</strong>
        {titleOf(row) !== record.name && <code className="skd-slug">{record.name}</code>}
        <span>{record.version}</span>
        <span className="ccp-badge">{record.status}</span>
        {!on && <span className="ccp-badge">{CL.skillOff}</span>}
        <Button type="button" size="xs" variant="secondary" onClick={onClose}>{CL.skillBack}</Button>
      </header>
      {description && <p>{description}</p>}
      <dl className="skd-meta" aria-label="Skill details">
        {meta.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      <p><small>{CL.skillAudienceHelp[record.audience]}</small></p>
      <p>{CL.skillCaps}: {record.caps.length > 0 ? record.caps.join(', ') : CL.skillCapsNone}</p>
      {body ? <SkillContent body={body} /> : <p className="skd-muted">{CL.skillNoBody}</p>}
      {builtin && <p className="skd-note">{CL.skillBuiltinReadOnly}</p>}
      <footer className="skd-footer">
        {revise}
        {record.audience === 'canvas' && active && (
          <Button type="button" size="sm" variant="secondary" disabled={!canAdd || !addSkillNode} onClick={addToCanvas}>{SN.addToCanvas}</Button>
        )}
        {active && (
          <label className="ccp-cap"><Switch checked={on} disabled={toggle.busy} aria-label={CL.skillEnabled} onCheckedChange={(v) => { target.current = v; void toggle.run() }} />{on ? SD.switchOn : SD.switchOff}</label>
        )}
      </footer>
      {active && <small role="status">{on ? CL.skillEnabledOn : CL.skillEnabledOff}</small>}
      {active && <ActionResult action={toggle} />}
      {record.audience === 'canvas' && active && (
        <div>
          {!canAdd && <small>{SN.addToCanvasOnly}</small>}
          {canAdd && !addSkillNode && <small>{SN.addToCanvasNoBoard}</small>}
          {added && <small role="status"> {added}</small>}
        </div>
      )}
    </article>
  )
}
