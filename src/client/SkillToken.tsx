import { Button } from '@/components/ui/button'
import { IconButton, IconTooltip } from '@/components/ui/icon-button'
import { SkillGlyph } from './SkillGlyph'
import type { SkillStatus } from './skillNode.model'
import { SN } from './skillNode.labels'
import './skillNode.shape.css'

export interface SkillTokenProps {
  title: string
  slug?: string
  status: SkillStatus
  /** Version to show on the ring ("v2"); only an active skill has one. */
  version?: string
  attached: boolean
  statusWord: string
  /** Set (with the version that was seen) while the active version moved on. */
  updated?: { text: string; dismiss: () => void }
  onExpand: () => void
  onRemove: () => void
}

const STATUS_ICON: Partial<Record<SkillStatus, string>> = { active: 'check', disabled: 'circle-slash', unavailable: 'warning' }

/**
 * Collapsed skill node: a round token (glyph in an accent ring, status mark and version on the rim) with the
 * title as a label underneath, like the sub-node tokens of n8n. The silhouette is a circle on purpose, so a skill
 * reads differently from every square node card, even zoomed out (docs/decisions/skill-node-shape.md).
 */
export function SkillToken({ title, slug, status, version, attached, statusWord, updated, onExpand, onRemove }: SkillTokenProps) {
  const warn = status === 'disabled' || status === 'unavailable'
  const cls = ['skill-token', `skill-token--${status}`, attached ? '' : 'skill-token--detached', warn ? 'skill-node--unavailable' : ''].filter(Boolean).join(' ')
  return (
    <div className={cls} data-shape="token">
      <div className="skill-token__ring" onDoubleClick={onExpand}>
        <SkillGlyph />
        {STATUS_ICON[status] && <span className={`skill-token__mark skill-token__mark--${status}`} aria-hidden="true"><span className={`codicon codicon-${STATUS_ICON[status]}`} /></span>}
        {version && <span className="skill-token__version">{SN.version(version)}</span>}
        {updated && <span className="skill-token__pulse" aria-hidden="true" />}
      </div>
      <div className="skill-token__actions nodrag">
        <IconButton label={SN.expand} size="icon-xs" variant="secondary" onClick={onExpand}><span className="codicon codicon-chevron-down" aria-hidden="true" /></IconButton>
        <IconButton label={SN.removeAria} size="icon-xs" variant="secondary" onClick={onRemove}><span className="codicon codicon-close" aria-hidden="true" /></IconButton>
      </div>
      <div className="skill-token__label">
        <IconTooltip label={title} side="bottom">
          <span className="skill-token__title" tabIndex={0}>{title}</span>
        </IconTooltip>
        {slug && slug !== title && <code className="skill-token__slug">{slug}</code>}
        {warn && (
          <span className="skill-node__badge skill-node__badge--off">
            <span className={`codicon ${status === 'disabled' ? 'codicon-circle-slash' : 'codicon-warning'}`} aria-hidden="true" />
            {statusWord}
          </span>
        )}
        {updated && (
          <Button type="button" size="xs" variant="secondary" className="skill-node__badge skill-node__badge--updated nodrag" aria-label={SN.updatedHint} onClick={updated.dismiss}>{updated.text}</Button>
        )}
      </div>
    </div>
  )
}
